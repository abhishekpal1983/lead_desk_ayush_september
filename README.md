# Lead Desk

A standalone service for Topmate sales ops: per agent calling queues, per lead progress history,
and bulk reassignment that writes back to HubSpot.

It is deliberately **separate from `agent_lead_bucket`**. Its own repo, its own Railway service,
its own token, its own cache. It does not touch the Call Now view, the revenue pages, or any
existing sync in that app. If this service is down, nothing over there changes.

## What it answers that the other app does not

Per lead, not just per bucket:

| Field | Where it comes from |
|---|---|
| Calls in current stage, and by the current owner | `callscurrent_stage` and `call_in_current_stage_by_current_owner`. The gap between them is inherited effort |
| Stage moves, and the full stage path with dates | `propertiesWithHistory` on `contact_engagement_stage` |
| First counselled | The first entry in that history into any counselling stage. This is the vetted definition, not the current stage |
| Owner moves, and the full owner path | `propertiesWithHistory` on `hubspot_owner_id` |
| Assigned to current owner on | The last entry in the owner history. Answers "how long has this person actually had it" |
| Last call | `last_call_date_and_time` on the contact |
| Transcript | `call_engagement_transcript_real_one`, fetched one lead at a time in the detail drawer |

The transcript is **never** in a bulk fetch. It is multi kilobyte per lead, no list view shows it,
and adding it to the list sync would multiply the payload for nothing.

## Scoring

Each lead gets an expected September value: the stage's chance of paying this month, discounted by
how many calls it has already taken in that stage, multiplied by the creator's average first payment.

- 0 calls in stage keeps the full chance, 1 to 2 keeps 90 percent, 3 to 5 keeps 60, 6 or more keeps 35
- Tiers fall out of the rupee value: P1 at or above 2,000, P2 at or above 1,000, P3 at or above 400, P4 below

The weights live at the top of `server.js` under `STAGE_P`, `depthFactor` and `TICKETS`. They are
judgement, calibrated against the agreed base case. Change them in one place and every queue reorders.

## Scope rules

`SCOPE` in `server.js` holds the per creator qualification. Today only `ayush_singh13` has one:
professionals and unknowns everywhere, students only once they reach pricing pitched, counselled or
payment prospect, and no Pakistan or Bangladesh numbers. Every other creator passes everything through.
Add a creator by adding a `test(lead)` and a human readable `label`; the label is served on `/api/meta`
so the UI can always say what it is filtering.

## Setup

```bash
cp .env.example .env      # fill in HUBSPOT_TOKEN
npm install
npm start                 # http://localhost:3000
```

### Token scopes

| Scope | Needed for |
|---|---|
| `crm.objects.contacts.read` | leads, properties, and the property history that drives every progress field |
| `crm.objects.owners.read` | agent names, including archived owners |

**This service never writes to HubSpot.** It holds no write scope and has no endpoint that could
change a contact, so the existing `agent_lead_bucket` service key works without modification.
Reassignment happens in HubSpot: the Assign tab copies the selected leads' emails, semicolon
separated, and you paste them into a Contacts filter on Email "is any of", select all, and use
Assign there. The destructive step keeps HubSpot's own audit trail and undo.

The desk does own two pieces of state, and both are local to it: prospects added here by hand, and
the notes typed against a lead. Neither reaches the CRM, so a note is invisible from inside HubSpot.

Set `DESK_KEY` to something long in any shared deployment, so the notes, the hand added list and
`/api/refresh` cannot be touched by anyone who has the URL.

## The desk's own data

Everything else in this process is a cache that rebuilds from HubSpot on boot. The notes and the
hand added prospects cannot be rebuilt, so they are written to `DATA_DIR/desk.json` (default
`/data`), replaced atomically through a temp file and a rename so a crash mid write cannot truncate
it. On Railway that path must be a **mounted volume** or a redeploy erases it.

Whether a volume is actually mounted cannot be detected from inside the container, so the file
counts boots. A file that comes back carrying a previous boot has outlived a restart, which is the
only honest proof the disk is persistent. Until that happens the masthead reads *disk unproven,
attach a volume*, and afterwards *notes on disk*.

## Adding a prospect by hand

`POST /api/manual {email}` looks the contact up in HubSpot, builds it through the same `buildLead`
the sync uses, and pins it. Two consequences worth knowing:

- The lead sits outside every sync filter, so `syncLeads`'s sweep is told to spare pinned ids and
  `syncPinned` refreshes them by id on each pass.
- A pinned lead is admitted even when it fails its creator's qualification rule. `scopeFail` records
  which rule it went around and the UI marks the row **BY HAND**, so an override is visible rather
  than quietly moving the counts. Removing the pin puts the lead back under the normal rule.

## Sync cadence

| Sync | Default | Cost |
|---|---|---|
| leads | every 10 min | one search per creator per stage group, split by create date whenever a partition exceeds 9,000 |
| history | every 60 min | `batch/read` at 50 ids per call, in scope workable and IFC leads only |
| owners | every 6 h | two passes, active and archived |

History is the expensive one. It is deliberately limited to in scope workable and parked leads,
which is a few thousand rather than the hundred and twenty thousand records these creators hold
between them. Widening that filter will make the sync take hours, so widen it on purpose or not at all.

## API

| Route | Does |
|---|---|
| `GET /api/meta` | creators, scope rule labels, sync status, and whether the store has proved itself |
| `GET /api/agents?creator=` | every owner holding leads, with counts by stage group, P1 count, overdue, uncalled, value |
| `GET /api/leads?creator=&owner=&stage=&tier=&group=&ownerState=&manual=&noted=&minValue=&limit=` | the queue, ordered by value, with agent and stage aggregates taken over the whole filtered set rather than the returned page |
| `GET /api/lead/:id` | one lead in full: stage path, owner path, notes, transcript |
| `POST /api/manual {email}` | look a contact up by email and pin it into the desk |
| `DELETE /api/manual/:id` | unpin it, putting it back under the normal scope rule |
| `POST /api/comment/:id {text, by, agent}` | record what was said. Desk only, never HubSpot |
| `DELETE /api/comment/:id/:idx` | remove one note |
| `POST /api/refresh` | kick every sync |
| `GET /api/health` | running SHA free health check for the deploy |

Every route that changes something respects `DESK_KEY` through the `x-desk-key` header.

## Deploy on Railway

1. New GitHub repo, push this directory.
2. New Railway **service**, not a new environment on the existing one. Point it at the repo.
3. Set the env vars from `.env.example`.
4. Confirm the build is live at `/api/health` with a cache busting query, since a plain fetch can
   return a response cached from an older build.
5. Watch the logs for `leads: N`, `calls: N`, `history: N`. First boot takes a few minutes.
6. That is the whole setup. There is no write step, because the desk never writes.

## What is synced, and what is not

Only callable leads: the nine workable stages, interested in future, and fresh. **Churned and won
are deliberately not synced.** They are the bulk of the records, they are in nobody's calling queue,
and including them pushed single partitions past HubSpot's 10,000 result ceiling.

That ceiling is the thing to understand before changing any query here. The search API does not
return an empty page past 10,000, it returns a 400. So every partition is probed for its total
first, and any partition above 9,000 is split down the middle by create date and retried,
recursively. The calls sync walks its 120 day window a week at a time for the same reason.

## Known limits

- In memory only. A restart rebuilds from HubSpot, which takes a few minutes and costs nothing else.
- `previous_engagement_stage` is not used anywhere here. It records `ghosted` for 479 of 499 ghosted
  leads, so it cannot say which stage a lead ghosted from. Stage history is the only honest source.
- There is no call-object sync. Call counts come from `callscurrent_stage`, which resets when a lead
  changes stage, so it means calls made since the lead reached its present stage, not calls ever made.
  Walking the call objects meant paging roughly 25,000 records a week through a search API that caps
  at 10,000, for three numbers already sitting on the contact.
- The desk does not create tasks, log activity, or change any record. It reads and ranks, nothing else.
