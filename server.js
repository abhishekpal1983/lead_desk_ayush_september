'use strict';
/*
 * Lead Desk. A standalone service for Topmate sales ops.
 * Deliberately separate from agent_lead_bucket: its own repo, its own Railway service,
 * its own token. Nothing here reads or writes that app's caches or pages.
 *
 * What it does
 *   - keeps a live picture of every workable and fresh lead for the configured creators
 *   - tracks progress per lead: calls, stage movement, owner movement, last conversation
 *   - serves a per agent calling queue ordered by expected value
 *   - reassigns leads in bulk, writing back to HubSpot when ALLOW_WRITE is set
 */

const express = require('express');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const TOKEN = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
const CREATORS = (process.env.CREATORS || '').split(',').map(s => s.trim()).filter(Boolean);
const PORTAL = process.env.HS_PORTAL_ID || '';
const UI = process.env.HS_UI_DOMAIN || 'app.hubspot.com';
const ALLOW_WRITE = process.env.ALLOW_WRITE === '1';
const DESK_KEY = process.env.DESK_KEY || '';
const MIN = 60 * 1000;

const WORKABLE = ['rcb_requested_callback', 'discovery', 'program_pitched', 'pricing_pitched',
  'counselled', 'Follow up', 'FU_DNP', 'FU_RCB', 'payment_prospect'];
const LATE = ['pricing_pitched', 'counselled', 'payment_prospect'];
const EARLY = ['rcb_requested_callback', 'discovery', 'program_pitched'];
const FOLLOWUP = ['Follow up', 'FU_DNP', 'FU_RCB'];
const CHURNED = ['dnp_did_not_pick', 'ghosted', 'ni_not_interested', 'disqualified'];

// Properties pulled in bulk. The transcript is deliberately NOT here: it is multi kilobyte
// per lead and no list view shows it. It is fetched one lead at a time in /api/lead/:id.
const PROPS = ['hs_object_id', 'firstname', 'lastname', 'email', 'phone', 'topmate_username',
  'contact_engagement_stage', 'hubspot_owner_id', 'callscurrent_stage',
  'call_in_current_stage_by_current_owner', 'last_call_date_and_time', 'follow_up_date_and_time',
  'engagement_stage_last_changed_at', 'createdate', 'conversion_probability_score',
  'are_you_a_student_or_working_professional', 'tm_student_or_professional', 'counselling_done',
  'counselling_date', 'actual_source', 'international_number', 'num_contacted_notes'];

// ---------------------------------------------------------------- scoring
// Chance a lead in this stage pays inside the month, before any call-depth adjustment.
const STAGE_P = {
  payment_prospect: 0.28, pricing_pitched: 0.18, counselled: 0.09, program_pitched: 0.07,
  'Follow up': 0.06, FU_RCB: 0.055, discovery: 0.045, rcb_requested_callback: 0.035,
  FU_DNP: 0.025, IFC: 0.015, __fresh: 0.015
};
// A lead that has taken calls in this stage without moving is worth less than an untouched one.
function depthFactor(calls) {
  const c = Number(calls) || 0;
  if (c === 0) return 1.0;
  if (c <= 2) return 0.9;
  if (c <= 5) return 0.6;
  return 0.35;
}
// Average FIRST payment per creator, as JSON in the TICKETS env var, for example
//   TICKETS={"creator_one":90000,"creator_two":40000}
// Kept out of the code deliberately: these are commercial figures and this repo is public.
// Any creator missing from TICKETS falls back to DEFAULT_TICKET.
const TICKETS = JSON.parse(process.env.TICKETS || '{}');
const DEFAULT_TICKET = Number(process.env.DEFAULT_TICKET) || 50000;

function scoreOf(lead) {
  const stage = lead.stage || '__fresh';
  const p = STAGE_P[stage];
  if (p === undefined) return 0;
  return Math.round(p * depthFactor(lead.callsInStage) * (TICKETS[lead.creator] || DEFAULT_TICKET));
}
function tierOf(v) { return v >= 2000 ? 'P1' : v >= 1000 ? 'P2' : v >= 400 ? 'P3' : 'P4'; }

// ---------------------------------------------------------------- scope rules
// Per creator qualification. Keep this in one place so the desk and the plan agree.
const SCOPE = {
  ayush_singh13: {
    // professionals anywhere, students only once counselled, no PK or BD numbers
    test(l) {
      const ph = l.phone || '';
      if (ph.startsWith('+92') || ph.startsWith('+880')) return false;
      if (l.student === 'student') return LATE.includes(l.stage);
      return true;
    },
    label: 'professionals and unknowns everywhere, students only at pricing pitched, counselled or payment prospect, no Pakistan or Bangladesh numbers'
  }
};
function inScope(l) {
  const rule = SCOPE[l.creator];
  return rule ? rule.test(l) : true;
}

// ---------------------------------------------------------------- hubspot client
async function hs(path, opts = {}) {
  if (!TOKEN) throw new Error('HUBSPOT_TOKEN is not set');
  const res = await fetch('https://api.hubapi.com' + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (res.status === 429) {                       // respect the rate limiter rather than hammering it
    await sleep(2000);
    return hs(path, opts);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HubSpot ${res.status} on ${path}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

// ---------------------------------------------------------------- state
const S = {
  leads: new Map(),        // id -> lead
  owners: new Map(),       // ownerId -> {name, active, email}
  meta: {
    leads: { at: null, n: 0, err: null },
    history: { at: null, n: 0, err: null },
    calls: { at: null, n: 0, err: null },
    owners: { at: null, n: 0, err: null }
  },
  writable: ALLOW_WRITE
};

function ymd(v) {
  if (!v) return '';
  const d = new Date(v);                    // HubSpot sends ISO strings. Never parseInt these.
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}
function daysSince(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function studentOf(p) {
  const drop = (p.are_you_a_student_or_working_professional || '').toLowerCase();
  if (drop.includes('student')) return 'student';
  if (drop.includes('professional')) return 'professional';
  const free = (p.tm_student_or_professional || '').toLowerCase();
  if (free.includes('stud')) return 'student';
  if (free.includes('rofessional') || free === 'wp' || free === 'pro') return 'professional';
  return 'unknown';
}

// ---------------------------------------------------------------- sync: leads
async function syncLeads() {
  const seen = new Set();
  let total = 0;
  for (const creator of CREATORS) {
    // Search caps at 10,000 per query, so partition by creator and then by stage group.
    const groups = [WORKABLE, ['IFC'], CHURNED, ['deal_won'], null]; // null = fresh, stage empty
    for (const group of groups) {
      let after = undefined;
      do {
        const filters = [{ propertyName: 'topmate_username', operator: 'EQ', value: creator }];
        if (group) filters.push({ propertyName: 'contact_engagement_stage', operator: 'IN', values: group });
        else filters.push({ propertyName: 'contact_engagement_stage', operator: 'NOT_HAS_PROPERTY' });
        const body = { filterGroups: [{ filters }], properties: PROPS, limit: 100 };
        if (after) body.after = after;
        const page = await hs('/crm/v3/objects/contacts/search', { method: 'POST', body: JSON.stringify(body) });
        for (const r of page.results || []) {
          const p = r.properties || {};
          const id = r.id;
          const prev = S.leads.get(id) || {};
          const lead = {
            id,
            name: [p.firstname, p.lastname].filter(Boolean).join(' ').trim() || (p.email || '').split('@')[0] || 'no name',
            email: (p.email || '').toLowerCase(),
            phone: p.phone || '',
            creator: p.topmate_username || '',
            stage: p.contact_engagement_stage || '',
            ownerId: p.hubspot_owner_id || '',
            callsInStage: Number(p.callscurrent_stage) || 0,
            callsByOwner: Number(p.call_in_current_stage_by_current_owner) || 0,
            lastCallAt: p.last_call_date_and_time || '',
            followUpAt: p.follow_up_date_and_time || '',
            stageChangedAt: p.engagement_stage_last_changed_at || '',
            createdAt: p.createdate || '',
            score: p.conversion_probability_score ? Number(p.conversion_probability_score) : null,
            student: studentOf(p),
            counsellingDone: p.counselling_done === 'true',
            counsellingDate: p.counselling_date || '',
            source: p.actual_source || '',
            intl: p.international_number === 'true',
            touches: Number(p.num_contacted_notes) || 0,
            // progress fields, filled by the history and calls syncs, preserved across lead syncs
            progress: prev.progress || null
          };
          lead.daysInStage = daysSince(lead.stageChangedAt);
          lead.value = scoreOf(lead);
          lead.tier = tierOf(lead.value);
          lead.inScope = inScope(lead);
          S.leads.set(id, lead);
          seen.add(id);
          total++;
        }
        after = page.paging && page.paging.next && page.paging.next.after;
        await sleep(120);                      // ~8 requests a second, comfortably inside the limit
      } while (after);
    }
  }
  for (const id of [...S.leads.keys()]) if (!seen.has(id)) S.leads.delete(id);  // drop leads that left scope
  S.meta.leads = { at: new Date().toISOString(), n: total, err: null };
  return total;
}

// ---------------------------------------------------------------- sync: owners
async function syncOwners() {
  let n = 0;
  for (const archived of [false, true]) {
    let after = undefined;
    do {
      const q = `/crm/v3/owners?limit=100&archived=${archived}` + (after ? `&after=${after}` : '');
      const page = await hs(q);
      for (const o of page.results || []) {
        S.owners.set(String(o.id), {
          name: [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email || ('owner ' + o.id),
          email: o.email || '',
          active: !archived
        });
        n++;
      }
      after = page.paging && page.paging.next && page.paging.next.after;
    } while (after);
  }
  S.meta.owners = { at: new Date().toISOString(), n, err: null };
  return n;
}

// ---------------------------------------------------------------- sync: property history
// This is what answers "how has this lead moved" and "when did it land with its current owner".
// batch/read accepts 50 ids per call and returns every historical value of the named properties.
async function syncHistory() {
  const ids = [...S.leads.values()]
    .filter(l => l.inScope && (WORKABLE.includes(l.stage) || l.stage === 'IFC'))
    .map(l => l.id);
  let n = 0;
  for (const batch of chunk(ids, 50)) {
    const body = {
      propertiesWithHistory: ['contact_engagement_stage', 'hubspot_owner_id'],
      properties: ['hs_object_id'],
      inputs: batch.map(id => ({ id }))
    };
    let page;
    try {
      page = await hs('/crm/v3/objects/contacts/batch/read', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      S.meta.history.err = e.message;
      continue;
    }
    for (const r of page.results || []) {
      const lead = S.leads.get(r.id);
      if (!lead) continue;
      const h = r.propertiesWithHistory || {};
      const stageHist = (h.contact_engagement_stage || [])
        .map(v => ({ value: v.value, at: v.timestamp }))
        .filter(v => v.value)
        .sort((a, b) => new Date(a.at) - new Date(b.at));
      const ownerHist = (h.hubspot_owner_id || [])
        .map(v => ({ value: v.value, at: v.timestamp }))
        .filter(v => v.value)
        .sort((a, b) => new Date(a.at) - new Date(b.at));

      // Collapse repeats: HubSpot writes a history entry on every save, not only on change.
      const dedupe = arr => arr.filter((v, i) => i === 0 || v.value !== arr[i - 1].value);
      const stagePath = dedupe(stageHist);
      const ownerPath = dedupe(ownerHist);

      const firstCounselled = stagePath.find(v =>
        ['discovery', 'program_pitched', 'pricing_pitched', 'counselled', 'payment_prospect',
          'Follow up', 'FU_DNP', 'FU_RCB'].includes(v.value));

      lead.progress = {
        stageChanges: Math.max(stagePath.length - 1, 0),
        stagePath: stagePath.map(v => ({ stage: v.value, at: v.at })),
        firstWorkedAt: stagePath.length ? stagePath[0].at : '',
        firstCounselledAt: firstCounselled ? firstCounselled.at : '',
        ownerChanges: Math.max(ownerPath.length - 1, 0),
        ownerPath: ownerPath.map(v => ({ ownerId: v.value, at: v.at })),
        assignedToCurrentOwnerAt: ownerPath.length ? ownerPath[ownerPath.length - 1].at : '',
        daysWithCurrentOwner: ownerPath.length ? daysSince(ownerPath[ownerPath.length - 1].at) : null,
        // a lead worked by someone else and never touched since it moved is the reassignment blind spot
        inheritedUntouched: lead.callsInStage > 0 && lead.callsByOwner === 0,
        calls: (lead.progress && lead.progress.calls) || null
      };
      n++;
    }
    await sleep(150);
  }
  S.meta.history = { at: new Date().toISOString(), n, err: S.meta.history.err };
  return n;
}

// ---------------------------------------------------------------- sync: calls
// The contact properties that look like call counts are traps: call_attempts is populated on
// about three leads in twenty five, and num_contacted_notes counts emails and WhatsApp too.
// The only honest count is the call records themselves.
async function syncCalls() {
  const dispositions = new Map();
  try {
    const d = await hs('/crm/v3/properties/calls/hs_call_disposition');
    for (const o of (d.options || [])) dispositions.set(o.value, o.label);
  } catch (e) { /* labels are a nicety, carry on without them */ }

  const since = new Date(Date.now() - 120 * 86400000).toISOString();
  const byContact = new Map();
  let after = undefined, n = 0;
  do {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'hs_timestamp', operator: 'GTE', value: since }] }],
      properties: ['hs_timestamp', 'hs_call_disposition', 'hs_call_duration', 'hubspot_owner_id', 'hs_call_direction'],
      limit: 100
    };
    if (after) body.after = after;
    let page;
    try {
      page = await hs('/crm/v3/objects/calls/search', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) { S.meta.calls.err = e.message; break; }
    const ids = (page.results || []).map(r => r.id);
    if (ids.length) {
      // associations come back separately; one batch call per page keeps this cheap
      let assoc = { results: [] };
      try {
        assoc = await hs('/crm/v4/associations/calls/contacts/batch/read',
          { method: 'POST', body: JSON.stringify({ inputs: ids.map(id => ({ id })) }) });
      } catch (e) { /* a page without associations is not fatal */ }
      const map = new Map();
      for (const a of assoc.results || []) map.set(a.from.id, (a.to || []).map(t => t.toObjectId));
      for (const r of page.results || []) {
        const contacts = map.get(r.id) || [];
        const p = r.properties || {};
        for (const cid of contacts) {
          if (!byContact.has(String(cid))) byContact.set(String(cid), []);
          byContact.get(String(cid)).push({
            at: p.hs_timestamp,
            disposition: dispositions.get(p.hs_call_disposition) || p.hs_call_disposition || '',
            seconds: Math.round((Number(p.hs_call_duration) || 0) / 1000),
            ownerId: p.hubspot_owner_id || ''
          });
        }
      }
      n += ids.length;
    }
    after = page.paging && page.paging.next && page.paging.next.after;
    await sleep(150);
  } while (after);

  for (const [cid, calls] of byContact) {
    const lead = S.leads.get(cid);
    if (!lead) continue;
    calls.sort((a, b) => new Date(b.at) - new Date(a.at));
    const connected = calls.filter(c => /connect/i.test(c.disposition)).length;
    lead.progress = lead.progress || {};
    lead.progress.calls = {
      total: calls.length,
      connected,
      lastAt: calls[0] ? calls[0].at : '',
      lastDisposition: calls[0] ? calls[0].disposition : '',
      longestSeconds: calls.reduce((m, c) => Math.max(m, c.seconds), 0),
      recent: calls.slice(0, 12)
    };
  }
  S.meta.calls = { at: new Date().toISOString(), n, err: S.meta.calls.err };
  return n;
}

// ---------------------------------------------------------------- api
function shape(l) {
  const o = S.owners.get(l.ownerId);
  const pr = l.progress || {};
  return {
    id: l.id, name: l.name, email: l.email, creator: l.creator, stage: l.stage,
    tier: l.tier, value: l.value, inScope: l.inScope, student: l.student, score: l.score,
    callsInStage: l.callsInStage, callsByOwner: l.callsByOwner,
    daysInStage: l.daysInStage, followUpAt: ymd(l.followUpAt), lastCallAt: ymd(l.lastCallAt),
    createdAt: ymd(l.createdAt), source: l.source, intl: l.intl,
    ownerId: l.ownerId, ownerName: o ? o.name : (l.ownerId ? 'unresolved' : 'Unowned'),
    ownerActive: l.ownerId ? (o ? o.active : null) : 'unowned',
    url: `https://${UI}/contacts/${PORTAL}/record/0-1/${l.id}`,
    progress: {
      calls: pr.calls ? { total: pr.calls.total, connected: pr.calls.connected, lastAt: ymd(pr.calls.lastAt), lastDisposition: pr.calls.lastDisposition } : null,
      stageChanges: pr.stageChanges ?? null,
      firstCounselledAt: ymd(pr.firstCounselledAt),
      ownerChanges: pr.ownerChanges ?? null,
      assignedToCurrentOwnerAt: ymd(pr.assignedToCurrentOwnerAt),
      daysWithCurrentOwner: pr.daysWithCurrentOwner ?? null,
      inheritedUntouched: !!pr.inheritedUntouched
    }
  };
}

app.get('/api/meta', (req, res) => {
  res.json({
    creators: CREATORS, leads: S.leads.size, writable: S.writable,
    scopeRules: Object.fromEntries(Object.entries(SCOPE).map(([k, v]) => [k, v.label])),
    sync: S.meta, portal: PORTAL, ui: UI
  });
});

app.get('/api/agents', (req, res) => {
  const by = new Map();
  for (const l of S.leads.values()) {
    if (!l.inScope) continue;
    if (req.query.creator && l.creator !== req.query.creator) continue;
    const key = l.ownerId || 'unowned';
    if (!by.has(key)) {
      const o = S.owners.get(l.ownerId);
      by.set(key, {
        ownerId: l.ownerId, name: l.ownerId ? (o ? o.name : 'unresolved') : 'Unowned',
        active: l.ownerId ? (o ? o.active : null) : null,
        total: 0, fresh: 0, early: 0, followUp: 0, late: 0, ifc: 0, churned: 0,
        p1: 0, p2: 0, value: 0, overdue: 0, uncalled: 0
      });
    }
    const a = by.get(key);
    a.total++; a.value += l.value;
    if (!l.stage) a.fresh++;
    else if (EARLY.includes(l.stage)) a.early++;
    else if (FOLLOWUP.includes(l.stage)) a.followUp++;
    else if (LATE.includes(l.stage)) a.late++;
    else if (l.stage === 'IFC') a.ifc++;
    else if (CHURNED.includes(l.stage)) a.churned++;
    if (l.tier === 'P1') a.p1++; else if (l.tier === 'P2') a.p2++;
    if (l.followUpAt && new Date(l.followUpAt) < new Date()) a.overdue++;
    if (WORKABLE.includes(l.stage) && !l.callsInStage) a.uncalled++;
  }
  res.json([...by.values()].sort((x, y) => y.value - x.value));
});

app.get('/api/leads', (req, res) => {
  const { creator, owner, stage, tier, scope, group, minValue } = req.query;
  let out = [...S.leads.values()];
  if (scope !== 'all') out = out.filter(l => l.inScope);
  if (creator) out = out.filter(l => l.creator === creator);
  if (owner) out = out.filter(l => (l.ownerId || 'unowned') === owner);
  if (stage) out = out.filter(l => l.stage === stage);
  if (tier) out = out.filter(l => l.tier === tier);
  if (group === 'workable') out = out.filter(l => WORKABLE.includes(l.stage));
  if (group === 'late') out = out.filter(l => LATE.includes(l.stage));
  if (group === 'fresh') out = out.filter(l => !l.stage);
  if (minValue) out = out.filter(l => l.value >= Number(minValue));
  out.sort((a, b) => b.value - a.value);
  const limit = Math.min(Number(req.query.limit) || 3000, 10000);
  res.json({ total: out.length, rows: out.slice(0, limit).map(shape) });
});

// One lead, in full. The transcript is fetched here and only here.
app.get('/api/lead/:id', async (req, res) => {
  const lead = S.leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not in the desk cache' });
  const out = shape(lead);
  const pr = lead.progress || {};
  out.stagePath = (pr.stagePath || []).map(v => ({ stage: v.stage, at: ymd(v.at) }));
  out.ownerPath = (pr.ownerPath || []).map(v => {
    const o = S.owners.get(String(v.ownerId));
    return { owner: o ? o.name : String(v.ownerId), active: o ? o.active : null, at: ymd(v.at) };
  });
  out.recentCalls = (pr.calls && pr.calls.recent || []).map(c => {
    const o = S.owners.get(String(c.ownerId));
    return { at: ymd(c.at), disposition: c.disposition, seconds: c.seconds, by: o ? o.name : '' };
  });
  try {
    const r = await hs(`/crm/v3/objects/contacts/${lead.id}?properties=call_engagement_transcript_real_one,ryl_aicall_transcript,reason_for_notinteresteddisqualifiedghosted,ni_reason_notes`);
    const p = r.properties || {};
    out.transcript = p.call_engagement_transcript_real_one || '';
    out.aiTranscript = p.ryl_aicall_transcript || '';
    out.reason = p.reason_for_notinteresteddisqualifiedghosted || p.ni_reason_notes || '';
  } catch (e) {
    out.transcriptError = e.message;
  }
  res.json(out);
});

function guard(req, res) {
  if (DESK_KEY && req.get('x-desk-key') !== DESK_KEY) { res.status(401).json({ error: 'bad key' }); return false; }
  return true;
}

// Bulk reassignment. Writes to HubSpot only when ALLOW_WRITE is set and the token carries
// crm.objects.contacts.write. Without both it returns a dry run so the UI still works.
app.post('/api/assign', async (req, res) => {
  if (!guard(req, res)) return;
  const { ids, ownerId, dryRun } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids is required' });
  if (!ownerId) return res.status(400).json({ error: 'ownerId is required' });
  const owner = S.owners.get(String(ownerId));
  if (!owner) return res.status(400).json({ error: 'unknown ownerId' });
  if (!owner.active) return res.status(400).json({ error: 'that owner is archived, pick an active one' });

  const plan = ids.filter(id => S.leads.has(String(id))).map(String);
  if (dryRun || !ALLOW_WRITE) {
    return res.json({
      applied: false,
      reason: dryRun ? 'dry run requested' : 'ALLOW_WRITE is not set, so the desk is read only',
      wouldUpdate: plan.length, ownerId, ownerName: owner.name
    });
  }
  let updated = 0; const failures = [];
  for (const batch of chunk(plan, 100)) {
    try {
      await hs('/crm/v3/objects/contacts/batch/update', {
        method: 'POST',
        body: JSON.stringify({ inputs: batch.map(id => ({ id, properties: { hubspot_owner_id: String(ownerId) } })) })
      });
      for (const id of batch) {
        const l = S.leads.get(id);
        if (l) {
          l.ownerId = String(ownerId);
          l.progress = l.progress || {};
          l.progress.assignedToCurrentOwnerAt = new Date().toISOString();
          l.progress.daysWithCurrentOwner = 0;
          l.progress.ownerChanges = (l.progress.ownerChanges || 0) + 1;
        }
        updated++;
      }
    } catch (e) {
      failures.push({ batch: batch.length, error: e.message });
    }
    await sleep(200);
  }
  res.json({ applied: true, updated, failures, ownerId, ownerName: owner.name });
});

app.post('/api/refresh', async (req, res) => {
  if (!guard(req, res)) return;
  res.json({ started: true });
  runAll().catch(e => console.error('refresh failed', e));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, leads: S.leads.size, owners: S.owners.size, writable: S.writable, sync: S.meta, at: new Date().toISOString() });
});

// ---------------------------------------------------------------- scheduling
async function safe(name, fn) {
  try { const n = await fn(); console.log(`${name}: ${n}`); }
  catch (e) { console.error(`${name} failed:`, e.message); S.meta[name] = { ...(S.meta[name] || {}), err: e.message }; }
}
async function runAll() {
  await safe('owners', syncOwners);
  await safe('leads', syncLeads);
  await safe('calls', syncCalls);
  await safe('history', syncHistory);
}
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`lead desk listening on ${port}, ${CREATORS.length} creators, write ${ALLOW_WRITE ? 'enabled' : 'disabled'}`);
  runAll().catch(e => console.error('first sync failed', e));
  setInterval(() => safe('leads', syncLeads), (Number(process.env.SYNC_MINUTES) || 10) * MIN);
  setInterval(() => safe('history', syncHistory), (Number(process.env.HISTORY_MINUTES) || 60) * MIN);
  setInterval(() => safe('calls', syncCalls), (Number(process.env.CALLS_MINUTES) || 60) * MIN);
  setInterval(() => safe('owners', syncOwners), 6 * 60 * MIN);
});
