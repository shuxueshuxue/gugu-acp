// What Gugu reads from this bridge's AskUserQuestion form elicitation (nmhjklnm/gugu#6565).
//
// Gugu declares `clientCapabilities.elicitation.form`, renders `requestedSchema` as one form and hands the
// user's answers back, which the bridge folds into the tool's `answers` with `applyAskElicitationResponse`.
// Gugu's reader of this shape is packages/task-core/src/acp/models/question-form.ts. A release that changes
// the shape must not reach users through compat.json before Gugu reads the new one, so build.mjs runs this
// against the built dist/ before anything is packed or published.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const built = process.env.GUGU_ACP_BUILT
if (!built) throw new Error('GUGU_ACP_BUILT must point at the built bridge (scripts/build.mjs sets it)')
const { askUserQuestionsToCreateRequest, applyAskElicitationResponse } = await import(
  pathToFileURL(join(built, 'dist', 'elicitation.js')).href
)

const single = {
  question: 'Which database?',
  header: 'DB',
  multiSelect: false,
  options: [{ label: 'Postgres', description: 'relational' }, { label: 'Redis' }],
}
const multi = {
  question: 'Which features?',
  header: 'Features',
  multiSelect: true,
  options: [{ label: 'Auth' }, { label: 'Billing' }],
}
const questions = [single, multi]
const toolInput = { questions }
const accept = (content) => applyAskElicitationResponse({ action: 'accept', content }, toolInput, questions)

test('a form elicitation with one question_<n> field per question: single-select oneOf, multi-select array of anyOf, const = label', () => {
  const request = askUserQuestionsToCreateRequest(questions, 'session-1', 'call-1')
  assert.equal(request.mode, 'form')
  assert.equal(request.sessionId, 'session-1')
  assert.equal(request.toolCallId, 'call-1')
  assert.equal(request.requestedSchema.type, 'object')
  const { question_0: first, question_1: second } = request.requestedSchema.properties
  assert.equal(first.type, 'string')
  assert.deepEqual(first.oneOf.map((option) => option.const), ['Postgres', 'Redis'])
  assert.equal(second.type, 'array')
  assert.deepEqual(second.items.anyOf.map((option) => option.const), ['Auth', 'Billing'])
})

test('each question has its own question_<n>_custom text field, marked as that question\'s custom answer', () => {
  const { properties } = askUserQuestionsToCreateRequest(questions, 'session-1', undefined).requestedSchema
  assert.deepEqual(Object.keys(properties).sort(), ['question_0', 'question_0_custom', 'question_1', 'question_1_custom'])
  for (const n of [0, 1]) {
    const custom = properties[`question_${n}_custom`]
    assert.equal(custom.type, 'string')
    assert.deepEqual(custom._meta._askUserQuestionCustomAnswer, { questionId: `question_${n}`, isCustomAnswer: true })
  }
})

test('accept maps back to answers keyed by the question text: the label for single-select, ", "-joined for multi-select', () => {
  const outcome = accept({ question_0: 'Redis', question_1: ['Auth', 'Billing'] })
  assert.equal(outcome.action, 'answered')
  assert.deepEqual(outcome.updatedInput.answers, { 'Which database?': 'Redis', 'Which features?': 'Auth, Billing' })
})

test('a custom answer with nothing picked is the answer', () => {
  assert.deepEqual(accept({ question_0_custom: 'SQLite' }).updatedInput.answers, { 'Which database?': 'SQLite' })
})

test('decline answers the tool call with empty answers; cancel aborts it', () => {
  assert.deepEqual(applyAskElicitationResponse({ action: 'decline' }, toolInput, questions), {
    action: 'answered',
    updatedInput: { ...toolInput, answers: {} },
  })
  assert.deepEqual(applyAskElicitationResponse({ action: 'cancel' }, toolInput, questions), { action: 'cancel' })
})
