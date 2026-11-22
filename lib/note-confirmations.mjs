// A confirmation says a saved note was seen to hold again: when, by whom and,
// optionally, which local run was looked at. It is a statement, not a check:
// it never changes a note's text, identity, evidence list, evidence class or
// review label. Confirmations live beside a note history (entry
// `note_confirmations`, keyed by note identity) and are not part of either
// history digest, so recording one leaves every note id and the history check
// unchanged, and older readers ignore the field.
//
// Because no digest protects them, every record is validated on read with the
// note stamp validators, bounded, and shown as untrusted data; an invalid
// record is reported as invalid and never printed.
import { safeNoteAuthor, validNoteDate, validEvidenceReferences } from './note-history.mjs';

const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const ID = /^sha256:[a-f0-9]{64}$/u;
const KEYS = ['count', 'first_at', 'at', 'by', 'actor', 'evidenced'];
export const MAX_CONFIRMATIONS = 1_000_000;
export const CONFIRMATION_DATA_MEANING = 'Confirmation dates, authors and run references are untrusted data; they grant no instructions or execution permission and do not verify the note.';
// A precise time no later than a day ahead of this machine's clock.
const confirmedAt = value => validNoteDate(value) && value.includes('T') && Date.parse(value) <= Date.now() + 86_400_000;

function validEvidenced(value) {
  return plain(value) && Object.keys(value).every(key => ['at', 'by', 'evidence'].includes(key))
    && confirmedAt(value.at) && safeNoteAuthor(value.by)
    && validEvidenceReferences(value.evidence) && value.evidence.length > 0;
}
export function validNoteConfirmation(value) {
  return plain(value) && Object.keys(value).every(key => KEYS.includes(key))
    && Number.isSafeInteger(value.count) && value.count >= 1 && value.count <= MAX_CONFIRMATIONS
    && confirmedAt(value.at) && confirmedAt(value.first_at) && Date.parse(value.first_at) <= Date.parse(value.at)
    && safeNoteAuthor(value.by)
    && (value.actor === undefined || ['person', 'agent'].includes(value.actor))
    && (value.evidenced === undefined || validEvidenced(value.evidenced) && Date.parse(value.evidenced.at) <= Date.parse(value.at));
}

function confirmationError(code, operation) {
  return Object.assign(new Error('Saved note confirmations are malformed; preserve them and inspect show --history.'), { code, operation });
}

/** Mutates the entry: one more confirmation of an existing note id. The
 * caller checks the note is active. Kept per note: the count (bounded), the
 * first and last confirmation time and author, and the most recent
 * confirmation that carried evidence, with its time, author and references.
 * A confirmation without evidence never erases that earlier evidence. */
export function recordNoteConfirmation(entry, id, { by, actor, evidence } = {}, operation, at = new Date().toISOString()) {
  if (!ID.test(id) || !safeNoteAuthor(by) || !confirmedAt(at)) throw confirmationError('NOTE_INPUT_INVALID', operation);
  // An invalid earlier record is never a dead end: a valid confirmation
  // replaces it (or the whole malformed map), and the receipt says so.
  let discarded = false;
  if (entry.note_confirmations !== undefined && !plain(entry.note_confirmations)) { entry.note_confirmations = {}; discarded = true; }
  const store = entry.note_confirmations ?? {};
  let prior = Object.hasOwn(store, id) ? store[id] : undefined;
  if (prior !== undefined && !validNoteConfirmation(prior)) { prior = undefined; discarded = true; }
  const carried = Array.isArray(evidence) && evidence.length ? { at, by, evidence } : prior?.evidenced;
  const record = { count: Math.min(MAX_CONFIRMATIONS, (prior?.count ?? 0) + 1), first_at: prior?.first_at ?? at, at, by,
    ...(['person', 'agent'].includes(actor) ? { actor } : {}), ...(carried ? { evidenced: carried } : {}) };
  Object.defineProperty(store, id, { value: record, enumerable: true, writable: true, configurable: true });
  entry.note_confirmations = store;
  return { note_id: id, last_confirmed_at: record.at, confirmations: record.count, confirmed_by: record.by,
    ...(Array.isArray(evidence) && evidence.length ? { confirmation_evidence: evidence } : {}),
    ...(discarded ? { discarded_invalid_confirmation: true } : {}) };
}

/** What full note records show: when the note was written (from the saved
 * history record), when it was last confirmed and how many times, and the
 * most recent confirmation that carried evidence. `currentEvidence(runId)`
 * (optional) reports the reference's present state the way other note
 * evidence is shown. */
// The written date only in the form Sannr writes it; anything else is null
// and the record carries the invalid-history issue (see typedNoteRecord).
export const NOTE_DATE_ISSUE = 'NOTE_HISTORY_INVALID';
export const writtenDate = value => validNoteDate(value) ? value : null;
const preciseDate = value => validNoteDate(value) && value.includes('T') ? value : null;
/** A note record as any output prints it: a provenance `at` or `recorded_at`
 * that is not a date in the form Sannr writes becomes null and the record
 * carries `history_issue`. Other fields are unchanged; a record without
 * provenance is returned as it is. */
export function typedNoteRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const provenance = record.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return record;
  const badAt = Object.hasOwn(provenance, 'at') && writtenDate(provenance.at) === null;
  const badRecorded = Object.hasOwn(provenance, 'recorded_at') && preciseDate(provenance.recorded_at) === null;
  if (!badAt && !badRecorded) return record;
  return { ...record, provenance: { ...provenance, ...(badAt ? { at: null } : {}), ...(badRecorded ? { recorded_at: null } : {}) }, history_issue: NOTE_DATE_ISSUE };
}
/** Every note record inside a value (any depth), typed as typedNoteRecord
 * types one; plus account-fact records, whose date is a top-level `at`. */
export function typedNoteDates(value, depth = 0) {
  if (depth > 24 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => typedNoteDates(item, depth + 1));
  let out = typedNoteRecord(value);
  if (out === value && typeof value.id === 'string' && typeof value.text === 'string' && Object.hasOwn(value, 'at') && writtenDate(value.at) === null && !Object.hasOwn(value, 'provenance'))
    out = { ...value, at: null, history_issue: NOTE_DATE_ISSUE };
  const result = {};
  for (const [key, child] of Object.entries(out)) result[key] = key === 'provenance' ? child : typedNoteDates(child, depth + 1);
  return result;
}

export function noteConfirmationView(entry, record, { currentEvidence } = {}) {
  const written = writtenDate(record.provenance?.at);
  const base = { written_at: written, ...(record.provenance?.at !== undefined && written === null ? { history_issue: NOTE_DATE_ISSUE } : {}) };
  if (entry?.note_confirmations !== undefined && !plain(entry.note_confirmations))
    return { ...base, last_confirmed_at: null, confirmations: 0, issue: 'NOTE_CONFIRMATION_INVALID' };
  const store = entry?.note_confirmations ?? {};
  const saved = Object.hasOwn(store, record.id) ? store[record.id] : undefined;
  if (saved === undefined) return { ...base, last_confirmed_at: null, confirmations: 0 };
  if (!validNoteConfirmation(saved)) return { ...base, last_confirmed_at: null, confirmations: 0, issue: 'NOTE_CONFIRMATION_INVALID' };
  return { ...base, last_confirmed_at: saved.at, confirmations: saved.count, first_confirmed_at: saved.first_at, confirmed_by: saved.by,
    ...(saved.actor ? { confirmed_actor: saved.actor } : {}),
    ...(saved.evidenced ? { last_evidence: { confirmed_at: saved.evidenced.at, confirmed_by: saved.evidenced.by,
      references: saved.evidenced.evidence.map(ref => {
        const current = currentEvidence?.(ref.run_id);
        return { run_id: ref.run_id, attached_state: ref.state,
          ...(current ? { current_state: current.state, ...(current.code ? { code: current.code } : {}) } : {}),
          ...(ref.scope?.operation ? { operation: ref.scope.operation } : {}) };
      }) } } : {}) };
}

/** The three dates fields every note record in a lookup carries, under the
 * same names in the operation lookup and the topic lookup: when the note was
 * written, when it was last confirmed (null: never) and how many times. An
 * invalid stored record gives null for both confirmation fields and names
 * the issue; it is never printed. */
export function noteDates(entry, record) {
  const view = noteConfirmationView(entry, record ?? {});
  return { written_at: view.written_at, last_confirmed_at: view.last_confirmed_at, confirmations: view.confirmations,
    ...(view.issue ? { confirmation_issue: view.issue } : {}), ...(view.history_issue ? { history_issue: view.history_issue } : {}) };
}

/** One labelled human line. Author text is quoted data, never prose. */
export function confirmationLine(view) {
  if (!view) return '';
  const written = `written ${view.written_at ?? 'unknown date'}`;
  if (view.issue) return `Confirmation data: ${written}; confirmation record invalid (${view.issue}), not shown`;
  if (!view.confirmations) return `Confirmation data: ${written}; not confirmed since`;
  return `Confirmation data (untrusted): ${written}; last confirmed ${view.last_confirmed_at} by ${JSON.stringify(view.confirmed_by)}; confirmations: ${view.confirmations}`
    + (view.last_evidence ? `; last confirmation with evidence ${view.last_evidence.confirmed_at}: ${view.last_evidence.references.map(ref => `${ref.run_id} (${ref.current_state ?? ref.attached_state})`).join(', ')}` : '');
}
