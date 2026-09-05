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
 *   - hands you the selected leads' emails to paste into HubSpot, where reassignment happens
 *
 * It never writes to HubSpot. It holds no write scope and has no endpoint that could
 * change a contact. The two things it does own are local to the desk: a list of prospects
 * added here by hand, and the notes typed against a lead. Those live in a JSON file on the
 * attached volume, never in the CRM.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const TOKEN = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
const CREATORS = (process.env.CREATORS || '').split(',').map(s => s.trim()).filter(Boolean);
const PORTAL = process.env.HS_PORTAL_ID || '';
const UI = process.env.HS_UI_DOMAIN || 'app.hubspot.com';
const DESK_KEY = process.env.DESK_KEY || '';
const MIN = 60 * 1000;

// Identifies the deployed page. A tab left open for a week has no other way to notice that
// the HTML it is running is older than the service answering it.
const BUILD = (() => {
  try { return String(Math.round(fs.statSync(path.join(__dirname, 'public/index.html')).mtimeMs)); }
  catch (e) { return String(Date.now()); }
})();

const WORKABLE = ['rcb_requested_callback', 'discovery', 'program_pitched', 'pricing_pitched',
  'counselled', 'Follow up', 'FU_DNP', 'FU_RCB', 'payment_prospect'];
const LATE = ['pricing_pitched', 'counselled', 'payment_prospect'];
const EARLY = ['rcb_requested_callback', 'discovery', 'program_pitched'];
const FOLLOWUP = ['Follow up', 'FU_DNP', 'FU_RCB'];

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
// why() returns the reason a lead fails, or an empty string when it qualifies, so that a
// lead added by hand can be admitted while still showing which rule it went around.
const SCOPE = {
  ayush_singh13: {
    // professionals anywhere, students only once counselled, no PK or BD numbers
    why(l) {
      const ph = l.phone || '';
      if (ph.startsWith('+92')) return 'Pakistan number';
      if (ph.startsWith('+880')) return 'Bangladesh number';
      if (l.student === 'student' && !LATE.includes(l.stage)) {
        return 'student, and not yet at pricing pitched, counselled or payment prospect';
      }
      return '';
    },
    label: 'professionals and unknowns everywhere, students only at pricing pitched, counselled or payment prospect, no Pakistan or Bangladesh numbers'
  }
};
function scopeFail(l) {
  const rule = SCOPE[l.creator];
  return rule ? rule.why(l) : '';
}

// ---------------------------------------------------------------- hubspot client
async function hs(path, opts = {}, tries = { rate: 0, server: 0 }) {
  if (!TOKEN) throw new Error('HUBSPOT_TOKEN is not set');
  const res = await fetch('https://api.hubapi.com' + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (res.status === 429 && tries.rate < 10) {    // respect the rate limiter rather than hammering it
    await sleep(2000);
    return hs(path, opts, { ...tries, rate: tries.rate + 1 });
  }
  // A HubSpot 5xx is their side falling over, and on batch/read it is usually transient.
  // Backing off and trying again costs a few seconds; surfacing it immediately costs the
  // whole batch its data.
  if (res.status >= 500 && tries.server < 3) {
    await sleep(900 * (tries.server + 1) * (tries.server + 1));
    return hs(path, opts, { ...tries, server: tries.server + 1 });
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
    owners: { at: null, n: 0, err: null },
    meetings: { at: null, n: 0, err: null }
  },
  readOnly: true
};

// ---------------------------------------------------------------- local store
// The desk's own two pieces of state: prospects pinned here by hand, and notes typed
// against a lead. Neither goes near HubSpot. Both belong on a Railway volume, because
// everything else in this process is a cache that rebuilds on boot and these do not.
//
// Whether a volume is actually mounted cannot be detected directly, so the file counts
// boots. A file that comes back carrying a previous boot outlived a restart, which is
// the only honest proof that the disk is persistent. Until that happens the UI says so.
const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_FILE = path.join(DATA_DIR, 'desk.json');
const DB = { boots: 0, pinned: {}, comments: {} };
const store = { dir: DATA_DIR, writable: false, err: '', survivedRestart: false, boots: 0 };

function saveDB() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
    fs.renameSync(tmp, DB_FILE);        // atomic: a crash mid write cannot truncate the real file
    store.writable = true; store.err = '';
    return true;
  } catch (e) {
    store.writable = false; store.err = e.message;
    console.error('store write failed:', e.message);
    return false;
  }
}
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      DB.pinned = j.pinned || {};
      DB.comments = j.comments || {};
      DB.boots = Number(j.boots) || 0;
      store.survivedRestart = DB.boots > 0;
    }
  } catch (e) {
    console.error('store read failed, starting empty:', e.message);
    store.err = e.message;
  }
  DB.boots++;
  store.boots = DB.boots;
  saveDB();
  console.log(`store ${DB_FILE}: writable ${store.writable}, survived a restart ${store.survivedRestart}, ` +
    `${Object.keys(DB.pinned).length} pinned, ${Object.keys(DB.comments).length} leads with notes`);
}
const notesFor = id => DB.comments[id] || [];

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
// HubSpot's search API hard caps at 10,000 results per query: paging past it returns a 400,
// not an empty page. So every partition is probed first, and any partition over the cap is
// split down the middle by create date and retried, recursively, until each piece fits.
//
// Only callable leads are synced: the nine workable stages, parked interest, and fresh.
// Churned and won are deliberately excluded. They are the bulk of the records, they are not
// in anyone's calling queue, and pulling them was what pushed partitions over the cap.
const SYNC_GROUPS = [
  { name: 'workable', filter: { propertyName: 'contact_engagement_stage', operator: 'IN', values: WORKABLE } },
  { name: 'ifc', filter: { propertyName: 'contact_engagement_stage', operator: 'EQ', value: 'IFC' } },
  { name: 'fresh', filter: { propertyName: 'contact_engagement_stage', operator: 'NOT_HAS_PROPERTY' } }
];
const CAP = 9000;                     // stay clear of the 10,000 ceiling
const EPOCH = '2020-01-01';

async function searchPartition(filters, from, to, sink, depth = 0) {
  const range = { propertyName: 'createdate', operator: 'BETWEEN', value: from, highValue: to };
  const all = [...filters, range];
  const probe = await hs('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify({ filterGroups: [{ filters: all }], properties: ['hs_object_id'], limit: 1 })
  });
  const total = probe.total || 0;
  if (!total) return 0;
  if (total > CAP && depth < 14) {
    const a = new Date(from).getTime(), b = new Date(to).getTime();
    if (b - a > 86400000) {                         // still splittable
      const mid = new Date(Math.floor((a + b) / 2)).toISOString().slice(0, 10);
      return (await searchPartition(filters, from, mid, sink, depth + 1))
           + (await searchPartition(filters, mid, to, sink, depth + 1));
    }
    // a single day over the cap: take the first 9,000 and log it rather than fail the sync
    console.warn(`partition ${from} holds ${total}, above the cap and cannot be split further`);
  }
  let after, n = 0;
  do {
    const body = { filterGroups: [{ filters: all }], properties: PROPS, limit: 100 };
    if (after) body.after = after;
    const page = await hs('/crm/v3/objects/contacts/search', { method: 'POST', body: JSON.stringify(body) });
    for (const r of page.results || []) { sink(r); n++; }
    after = page.paging && page.paging.next && page.paging.next.after;
    if (n >= CAP) break;                             // never page into the 400
    await sleep(120);
  } while (after);
  return n;
}

async function syncLeads() {
  const seen = new Set();
  let total = 0;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  for (const creator of CREATORS) {
    for (const group of SYNC_GROUPS) {
      const filters = [
        { propertyName: 'topmate_username', operator: 'EQ', value: creator },
        group.filter
      ];
      total += await searchPartition(filters, EPOCH, tomorrow, r => {
        S.leads.set(r.id, buildLead(r));
        seen.add(r.id);
      });
    }
  }
  // A lead pinned by hand is not in any of these searches by definition, so the sweep has
  // to spare it. Everything else that stopped matching is dropped.
  for (const id of [...S.leads.keys()]) {
    if (seen.has(id) || DB.pinned[id]) continue;
    S.leads.delete(id);
  }
  S.meta.leads = { at: new Date().toISOString(), n: total, err: null };
  return total;
}

// One place that turns a HubSpot contact into a desk lead, so a hand added prospect is
// scored, tiered and shaped exactly like one that arrived through the sync.
function buildLead(r) {
  const p = r.properties || {};
  const prev = S.leads.get(r.id) || {};
  const lead = {
    id: r.id,
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
    progress: prev.progress || null,     // preserved across lead syncs
    meeting: prev.meeting || null,
    meetings: prev.meetings || null
  };
  lead.daysInStage = daysSince(lead.stageChangedAt);
  lead.value = scoreOf(lead);
  lead.tier = tierOf(lead.value);
  lead.scopeFail = scopeFail(lead);
  lead.manual = !!DB.pinned[r.id];
  // A hand added lead is admitted even when it fails a rule. scopeFail still records which
  // rule it went around, so the override is visible instead of silently changing the counts.
  lead.inScope = !lead.scopeFail || lead.manual;
  return lead;
}

// Pinned leads sit outside every sync filter, so they are refreshed by id on their own.
async function syncPinned() {
  const ids = Object.keys(DB.pinned);
  if (!ids.length) return 0;
  let n = 0;
  for (const batch of chunk(ids, 50)) {
    let page;
    try {
      page = await hs('/crm/v3/objects/contacts/batch/read', {
        method: 'POST',
        body: JSON.stringify({ properties: PROPS, inputs: batch.map(id => ({ id })) })
      });
    } catch (e) {
      console.error('pinned refresh failed:', e.message);
      continue;
    }
    for (const r of page.results || []) { S.leads.set(r.id, buildLead(r)); n++; }
    await sleep(120);
  }
  return n;
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
  // Start clean. The old code carried the previous run's error forward for ever, so one bad
  // hour left the masthead showing a failure long after the sync had recovered.
  const { n, failed } = await syncHistoryFor(ids);
  // A handful of records HubSpot cannot serve is a fact worth recording, not an alarm worth
  // painting red every hour. It only becomes an error when enough of the book is missing that
  // the progress fields stop being trustworthy.
  const bad = ids.length ? failed.length / ids.length : 0;
  S.meta.history = {
    at: new Date().toISOString(), n,
    skipped: failed.length,
    err: bad > 0.02
      ? `HubSpot could not return history for ${failed.length} of ${ids.length} contacts`
      : null,
    failed: failed.slice(0, 25)
  };
  if (failed.length) console.error('history: contacts HubSpot refused:', failed.slice(0, 25).join(', '));
  return n;
}
// Split out so a single lead added by hand can have its history filled straight away
// rather than waiting for the hourly pass.
// HubSpot answers this endpoint with a 500 often enough to matter, and a whole batch used to
// be abandoned when it did, so fifty leads lost their progress fields over one bad record.
// A failed batch is now halved and retried until either it succeeds or a single contact is
// isolated as the one HubSpot cannot serve. Only that contact is given up on, and it is named.
const HISTORY_BATCH = Math.min(Number(process.env.HISTORY_BATCH) || 25, 50);

async function syncHistoryFor(ids) {
  let n = 0;
  const failed = [];
  const queue = chunk(ids, HISTORY_BATCH);
  while (queue.length) {
    const batch = queue.shift();
    const body = {
      propertiesWithHistory: ['contact_engagement_stage', 'hubspot_owner_id'],
      properties: ['hs_object_id'],
      inputs: batch.map(id => ({ id }))
    };
    let page;
    try {
      page = await hs('/crm/v3/objects/contacts/batch/read', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        queue.unshift(batch.slice(0, mid), batch.slice(mid));   // bisect and come straight back to it
      } else {
        failed.push(batch[0]);
        console.error(`history: HubSpot will not return contact ${batch[0]}: ${e.message}`);
      }
      await sleep(500);
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
        inheritedUntouched: lead.callsInStage > 0 && lead.callsByOwner === 0
      };
      n++;
    }
    await sleep(150);
  }
  return { n, failed };
}

// ---------------------------------------------------------------- sync: meetings
// Whether a meeting was ever booked on a lead, and whether its slot has passed.
//
// hs_meeting_outcome cannot answer "was it held" on its own. Portal wide, 121 meetings are
// marked Completed against 3,017 left on Scheduled and 1,552 with no outcome at all; in
// August, 372 were booked and 2 were marked Completed. Nobody closes the loop on the field,
// so trusting it literally would report "no meeting" for almost every lead who sat in one.
//
// So a meeting counts as HELD when its start time has passed and nobody marked it Cancelled,
// No Show or Rescheduled. Upcoming meetings read BOOKED, which is an intent signal in its own
// right. A lead whose only meetings were cancelled or no-showed reads OFF rather than blank,
// because "they booked and did not turn up" is not the same as "they never engaged".
//
// This is a list, not a search, so the 10,000 cap does not apply and the whole object is
// cheap: roughly 4,800 meetings, 100 per page, under fifty calls.
const MEET_PROPS = ['hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_end_time',
  'hs_meeting_outcome', 'hs_timestamp'];
const MEET_FAILED = ['CANCELED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'];

async function syncMeetings() {
  const byContact = new Map();
  let after, pages = 0, seen = 0;
  do {
    const q = `/crm/v3/objects/meetings?limit=100&archived=false` +
      `&properties=${MEET_PROPS.join(',')}&associations=contacts` + (after ? `&after=${after}` : '');
    const page = await hs(q);
    for (const m of page.results || []) {
      seen++;
      const p = m.properties || {};
      const at = p.hs_meeting_start_time || p.hs_timestamp || '';
      const outcome = p.hs_meeting_outcome || '';
      const ids = ((m.associations && m.associations.contacts && m.associations.contacts.results) || [])
        .map(a => String(a.id));
      if (!ids.length) continue;
      const rec = { at, outcome, title: p.hs_meeting_title || '' };
      for (const id of ids) {
        if (!byContact.has(id)) byContact.set(id, []);
        byContact.get(id).push(rec);
      }
    }
    after = page.paging && page.paging.next && page.paging.next.after;
    if (++pages > 400) { console.warn('meetings sync stopped at 400 pages'); break; }
    await sleep(120);
  } while (after);

  // Attach to whatever leads the desk currently holds, clearing leads that no longer match.
  let n = 0;
  for (const lead of S.leads.values()) {
    const list = byContact.get(lead.id);
    attachMeetings(lead, list);
    if (list) n++;
  }
  S.meta.meetings = { at: new Date().toISOString(), n, err: null };
  console.log(`meetings: ${seen} scanned, ${byContact.size} contacts with one, ${n} matched a lead in the desk`);
  return n;
}

// A lead pinned by hand would otherwise show "never booked one" until the next full pass,
// which is worse than showing nothing, so its meetings are pulled by association right away.
async function syncMeetingsFor(ids) {
  for (const id of ids) {
    let list = [];
    try {
      const a = await hs(`/crm/v4/objects/contacts/${id}/associations/meetings?limit=100`);
      const mids = (a.results || []).map(x => String(x.toObjectId)).filter(Boolean);
      if (mids.length) {
        const r = await hs('/crm/v3/objects/meetings/batch/read', {
          method: 'POST',
          body: JSON.stringify({ properties: MEET_PROPS, inputs: mids.map(m => ({ id: m })) })
        });
        list = (r.results || []).map(m => ({
          at: m.properties.hs_meeting_start_time || m.properties.hs_timestamp || '',
          outcome: m.properties.hs_meeting_outcome || '',
          title: m.properties.hs_meeting_title || ''
        }));
      }
    } catch (e) {
      console.error('meetings for pinned lead failed:', e.message);
      continue;
    }
    attachMeetings(S.leads.get(id), list);
  }
}

// Shared by both paths so a hand added lead is judged by exactly the same rule.
function attachMeetings(lead, list) {
  if (!lead) return;
  if (!list || !list.length) { lead.meeting = null; lead.meetings = null; return; }
  list.sort((a, b) => new Date(b.at) - new Date(a.at));
  const now = Date.now();
  const usable = list.filter(m => !MEET_FAILED.includes(m.outcome));
  const held = usable.filter(m => m.at && new Date(m.at).getTime() < now);
  const upcoming = usable.filter(m => m.at && new Date(m.at).getTime() >= now);
  const marker = held[0] || upcoming[0] || list[0];
  lead.meetings = list.slice(0, 10);
  lead.meeting = {
    state: held.length ? 'held' : upcoming.length ? 'booked' : 'off',
    at: marker ? marker.at : '', title: marker ? marker.title : '',
    outcome: marker ? marker.outcome : '', n: list.length,
    completed: list.some(m => m.outcome === 'COMPLETED')
  };
}

// No calls sync. The contact itself carries what the desk needs: last_call_date_and_time
// for the last conversation, callscurrent_stage for calls made in the current stage, and
// call_in_current_stage_by_current_owner for how many of those the present owner made.
// Fetching the call objects meant walking roughly 25,000 records a week through a search
// API that caps at 10,000, for three numbers already sitting on the lead.

// ---------------------------------------------------------------- api
function shape(l) {
  const o = S.owners.get(l.ownerId);
  const pr = l.progress || {};
  const notes = notesFor(l.id);
  const last = notes.length ? notes[notes.length - 1] : null;
  return {
    manual: !!l.manual,
    scopeFail: l.scopeFail || '',
    meeting: l.meeting ? { ...l.meeting, at: ymd(l.meeting.at) } : null,
    addedAt: DB.pinned[l.id] ? ymd(DB.pinned[l.id].addedAt) : '',
    notes: notes.length,
    lastNote: last ? { at: ymd(last.at), by: last.by, agent: last.agent, text: last.text.slice(0, 200) } : null,
    id: l.id, name: l.name, email: l.email, creator: l.creator, stage: l.stage,
    tier: l.tier, value: l.value, inScope: l.inScope, student: l.student, score: l.score,
    callsInStage: l.callsInStage, callsByOwner: l.callsByOwner,
    daysInStage: l.daysInStage, followUpAt: ymd(l.followUpAt), lastCallAt: ymd(l.lastCallAt),
    createdAt: ymd(l.createdAt), source: l.source, intl: l.intl,
    ownerId: l.ownerId, ownerName: o ? o.name : (l.ownerId ? 'unresolved' : 'Unowned'),
    ownerActive: l.ownerId ? (o ? o.active : null) : 'unowned',
    url: `https://${UI}/contacts/${PORTAL}/record/0-1/${l.id}`,
    progress: {
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
    creators: CREATORS, leads: S.leads.size, readOnly: true,
    scopeRules: Object.fromEntries(Object.entries(SCOPE).map(([k, v]) => [k, v.label])),
    sync: S.meta, portal: PORTAL, ui: UI,
    keyed: !!DESK_KEY,        // so the page can ask for the key instead of failing at the first write
    build: BUILD,             // a long open tab can tell it is running last week's page

    store: { ...store, pinned: Object.keys(DB.pinned).length, noted: Object.keys(DB.comments).length }
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
        total: 0, fresh: 0, early: 0, followUp: 0, late: 0, ifc: 0,
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
    if (l.tier === 'P1') a.p1++; else if (l.tier === 'P2') a.p2++;
    if (l.followUpAt && new Date(l.followUpAt) < new Date()) a.overdue++;
    if (WORKABLE.includes(l.stage) && !l.callsInStage) a.uncalled++;
  }
  res.json([...by.values()].sort((x, y) => y.value - x.value));
});

// The rows are capped so the payload stays sane, but the agent chips, the stage
// dropdown and the summary must describe the WHOLE filtered set, not the first page
// of it. So the aggregates are computed before the slice and returned alongside.
app.get('/api/leads', (req, res) => {
  const { creator, owner, stage, tier, scope, group, minValue, ownerState, manual, noted, meeting } = req.query;
  let out = [...S.leads.values()];
  if (scope !== 'all') out = out.filter(l => l.inScope);
  if (manual === '1') out = out.filter(l => l.manual);
  if (noted === '1') out = out.filter(l => notesFor(l.id).length);
  if (meeting === 'any') out = out.filter(l => l.meeting);
  else if (meeting === 'none') out = out.filter(l => !l.meeting);
  else if (meeting) out = out.filter(l => l.meeting && l.meeting.state === meeting);
  if (creator) out = out.filter(l => l.creator === creator);
  if (group === 'workable') out = out.filter(l => WORKABLE.includes(l.stage));
  if (group === 'late') out = out.filter(l => LATE.includes(l.stage));
  if (group === 'fresh') out = out.filter(l => !l.stage);
  if (tier) out = out.filter(l => l.tier === tier);
  if (minValue) out = out.filter(l => l.value >= Number(minValue));

  // Stage counts are taken before the stage filter, otherwise the dropdown can only
  // ever offer the stage that is already selected.
  const stages = {};
  for (const l of out) stages[l.stage] = (stages[l.stage] || 0) + 1;
  if (stage) out = out.filter(l => l.stage === stage);

  // Same for the agent aggregates: they are taken before the owner filter so that
  // clicking one chip does not wipe out all the others.
  const agents = new Map();
  for (const l of out) {
    const id = l.ownerId || 'unowned';
    if (!agents.has(id)) {
      const o = l.ownerId ? S.owners.get(l.ownerId) : null;
      agents.set(id, {
        ownerId: l.ownerId || '', name: o ? o.name : (l.ownerId ? 'unresolved' : 'Unowned'),
        active: l.ownerId ? (o ? o.active : null) : 'unowned', n: 0, p1: 0, value: 0
      });
    }
    const a = agents.get(id);
    a.n++; a.value += l.value; if (l.tier === 'P1') a.p1++;
  }
  const agentList = [...agents.values()].sort((a, b) => b.value - a.value);

  // ownerState narrows to who holds the lead. "assignable" is everything an active
  // agent is not already holding, which is exactly what the assign tab lists.
  // "all" deliberately applies nothing, so a lead can be moved between two live agents rather
  // than only rescued from a dead account. Anything unrecognised is rejected rather than
  // silently behaving like "all", which would quietly widen a filter the caller thought was on.
  const OWNER_STATES = ['assignable', 'active', 'archived', 'unowned', 'all'];
  if (ownerState && !OWNER_STATES.includes(ownerState)) {
    return res.status(400).json({ error: `ownerState must be one of ${OWNER_STATES.join(', ')}` });
  }
  if (ownerState === 'assignable') out = out.filter(l => shapeActive(l) !== true);
  else if (ownerState === 'active') out = out.filter(l => shapeActive(l) === true);
  else if (ownerState === 'archived') out = out.filter(l => shapeActive(l) === false);
  else if (ownerState === 'unowned') out = out.filter(l => !l.ownerId);
  if (owner) out = out.filter(l => (l.ownerId || 'unowned') === owner);

  out.sort((a, b) => b.value - a.value);
  const limit = Math.min(Number(req.query.limit) || 3000, 10000);
  const value = out.reduce((s, l) => s + (l.value || 0), 0);
  res.json({
    total: out.length, value, truncated: out.length > limit,
    agents: agentList, stages, rows: out.slice(0, limit).map(shape)
  });
});
function shapeActive(l) {
  if (!l.ownerId) return 'unowned';
  const o = S.owners.get(l.ownerId);
  return o ? o.active : null;
}

// One lead, in full. The transcript is fetched here and only here.
app.get('/api/lead/:id', async (req, res) => {
  const lead = S.leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not in the desk cache' });
  const out = shape(lead);
  out.comments = notesFor(lead.id).map((c, i) => ({ ...c, at: c.at, idx: i }));
  out.meetings = (lead.meetings || []).map(m => ({ at: ymd(m.at), outcome: m.outcome, title: m.title }));
  const pr = lead.progress || {};
  out.stagePath = (pr.stagePath || []).map(v => ({ stage: v.stage, at: ymd(v.at) }));
  out.ownerPath = (pr.ownerPath || []).map(v => {
    const o = S.owners.get(String(v.ownerId));
    return { owner: o ? o.name : String(v.ownerId), active: o ? o.active : null, at: ymd(v.at) };
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

// Nothing below writes to HubSpot. Reassignment is done in HubSpot itself: copy the emails
// from the Assign tab, filter Contacts on Email "is any of", select all, and use Assign. That
// keeps the destructive step where it has an audit trail and an undo, and it means this service
// never needs a write scope on its token. The endpoints below only touch the desk's own file.

// ---------------------------------------------------------------- export
// Phone numbers are deliberately NOT on /api/leads. That endpoint is unauthenticated, and
// putting phones on it would mean anyone who has the URL could pull the whole book's numbers.
// They are only served here, behind DESK_KEY, for the ids the user actually selected.
app.post('/api/export', (req, res) => {
  if (!guard(req, res)) return;
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 10000) : [];
  if (!ids.length) return res.status(400).json({ error: 'no leads selected' });
  const rows = [];
  for (const id of ids) {
    const l = S.leads.get(String(id));
    if (!l) continue;
    const o = S.owners.get(l.ownerId);
    rows.push({
      name: l.name, phone: l.phone || '', email: l.email || '',
      creator: l.creator, stage: l.stage, tier: l.tier,
      meeting: l.meeting ? l.meeting.state : 'none',
      owner: o ? o.name : (l.ownerId ? 'unresolved' : 'Unowned'),
      daysInStage: l.daysInStage ?? '', value: l.value,
      lastCallAt: ymd(l.lastCallAt), followUpAt: ymd(l.followUpAt)
    });
  }
  res.json({ rows, missing: ids.length - rows.length });
});

// ---------------------------------------------------------------- manual prospects
// Paste an email, get the same lead every sync would have produced. Useful when an agent
// mentions a prospect the desk filtered out, or one belonging to a creator it does not sync.
app.post('/api/manual', async (req, res) => {
  if (!guard(req, res)) return;
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'that does not look like an email address' });
  }
  let hits;
  try {
    const r = await hs('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: PROPS, limit: 5
      })
    });
    hits = r.results || [];
  } catch (e) {
    return res.status(502).json({ error: 'HubSpot lookup failed: ' + e.message });
  }
  if (!hits.length) return res.status(404).json({ error: `HubSpot has no contact with the email ${email}` });

  const r = hits[0];
  DB.pinned[r.id] = { id: r.id, email, addedAt: new Date().toISOString() };
  const lead = buildLead(r);              // reads DB.pinned, so it comes back already flagged manual
  S.leads.set(r.id, lead);
  const persisted = saveDB();
  await syncMeetingsFor([r.id]).catch(e => console.error('meetings for pinned lead failed:', e.message));
  syncHistoryFor([r.id]).catch(e => console.error('history for pinned lead failed:', e.message));
  res.json({ ok: true, persisted, duplicates: hits.length - 1, lead: shape(lead) });
});

app.delete('/api/manual/:id', (req, res) => {
  if (!guard(req, res)) return;
  const id = req.params.id;
  if (!DB.pinned[id]) return res.status(404).json({ error: 'that lead was not added by hand' });
  delete DB.pinned[id];
  const lead = S.leads.get(id);
  if (lead) {
    lead.manual = false;
    lead.inScope = !lead.scopeFail;       // it keeps its place only if it qualifies on its own
  }
  res.json({ ok: true, persisted: saveDB() });
});

// ---------------------------------------------------------------- notes
// What was actually said, typed here after talking to the agent. Desk only: this never
// reaches the contact record, so it cannot be seen from inside HubSpot.
app.post('/api/comment/:id', (req, res) => {
  if (!guard(req, res)) return;
  const id = req.params.id;
  if (!S.leads.has(id)) return res.status(404).json({ error: 'that lead is not in the desk' });
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'the note is empty' });
  const c = {
    at: new Date().toISOString(),
    by: String((req.body && req.body.by) || '').trim().slice(0, 60),
    agent: String((req.body && req.body.agent) || '').trim().slice(0, 80),
    text: text.slice(0, 4000)
  };
  (DB.comments[id] = DB.comments[id] || []).push(c);
  res.json({ ok: true, persisted: saveDB(), comments: notesFor(id) });
});

app.delete('/api/comment/:id/:idx', (req, res) => {
  if (!guard(req, res)) return;
  const list = DB.comments[req.params.id];
  const i = Number(req.params.idx);
  if (!list || !list[i]) return res.status(404).json({ error: 'no such note' });
  list.splice(i, 1);
  if (!list.length) delete DB.comments[req.params.id];
  res.json({ ok: true, persisted: saveDB(), comments: notesFor(req.params.id) });
});

app.post('/api/refresh', async (req, res) => {
  if (!guard(req, res)) return;
  res.json({ started: true });
  runAll().catch(e => console.error('refresh failed', e));
});

// Lets the page check a key before the user has typed a note against it.
app.get('/api/keycheck', (req, res) => {
  if (!guard(req, res)) return;
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, leads: S.leads.size, owners: S.owners.size, readOnly: true, sync: S.meta, at: new Date().toISOString() });
});

// ---------------------------------------------------------------- scheduling
async function safe(name, fn) {
  try { const n = await fn(); console.log(`${name}: ${n}`); }
  catch (e) { console.error(`${name} failed:`, e.message); S.meta[name] = { ...(S.meta[name] || {}), err: e.message }; }
}
async function runAll() {
  await safe('owners', syncOwners);
  await safe('leads', syncLeads);
  await safe('pinned', syncPinned);      // after leads, so the sweep cannot drop them
  await safe('meetings', syncMeetings);  // needs the leads in place to attach to
  await safe('history', syncHistory);
}
const port = process.env.PORT || 3000;
loadDB();
app.listen(port, () => {
  console.log(`lead desk listening on ${port}, ${CREATORS.length} creators, no HubSpot writes`);
  runAll().catch(e => console.error('first sync failed', e));
  setInterval(() => safe('leads', syncLeads), (Number(process.env.SYNC_MINUTES) || 10) * MIN);
  setInterval(() => safe('meetings', syncMeetings), (Number(process.env.MEETING_MINUTES) || 30) * MIN);
  setInterval(() => safe('history', syncHistory), (Number(process.env.HISTORY_MINUTES) || 60) * MIN);
  setInterval(() => safe('owners', syncOwners), 6 * 60 * MIN);
});
