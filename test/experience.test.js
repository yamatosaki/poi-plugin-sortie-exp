'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createExperience } = require('../src/experience')

const roster = [
  { id: 101, name: '夕張', group: 'main', slot: 0 },
  { id: 102, name: '吹雪', group: 'main', slot: 1 },
]
const escort = { id: 201, name: '夕張', group: 'escort', slot: 0 }

function setup(store = new Map()) {
  const tracker = createExperience({
    load: id => store.get(id),
    save: (id, state) => store.set(id, JSON.parse(JSON.stringify(state))),
  })
  const send = (type, data = {}) => tracker.handle({ type, ...data })
  const start = (ships = roster) => send('sortie', { deckId: 1, map: '5-3', node: 1, roster: ships })
  const result = (main, escort, mvp, escortMvp) => {
    send('phase')
    send('result', { main, escort, mvp, escortMvp })
  }
  send('account', { accountId: '100' })
  return { ...tracker, send, start, result, store }
}

const exp = ships => Object.fromEntries(ships.map(ship => [ship.id, ship.exp]))
const mvpCounts = ships => Object.fromEntries(ships.map(ship => [ship.id, ship.mvpCount]))

test('MVP keeps live and tracked counts separate through return, restart and clear', () => {
  const t = setup()
  t.start()
  assert.deepEqual(mvpCounts(t.getSnapshot().current.ships), { 101: null, 102: null })
  t.result([-1, 100, 50], undefined, 1)
  t.send('result', { main: [-1, 100, 50], mvp: 1 })
  t.setTracking(true)
  t.send('next', { node: 2 })
  t.result([-1, 90, 60], undefined, '2')
  t.setTracking(false)
  assert.deepEqual(mvpCounts(t.getSnapshot().current.ships), { 101: 1, 102: 1 })
  assert.deepEqual(t.getSnapshot().totals, [])
  t.send('port')
  const reopened = setup(t.store)
  assert.deepEqual(mvpCounts(reopened.getSnapshot().last.ships), { 101: 1, 102: 1 })
  assert.deepEqual(mvpCounts(reopened.getSnapshot().totals), { 101: 0, 102: 1 })

  reopened.setTracking(true)
  reopened.start()
  reopened.result([-1, 50, 100], undefined, 2)
  reopened.clearTotal()
  reopened.send('port')
  assert.deepEqual(reopened.getSnapshot().totals, [])
  assert.equal(reopened.getSnapshot().totalSorties, 0)
  assert.deepEqual(mvpCounts(reopened.getSnapshot().last.ships), { 101: 0, 102: 1 })
})

test('combined MVP uses the original slots independently and skips retreated ships', () => {
  const t = setup()
  const escortMate = { ...escort, id: 202, slot: 1 }
  const seventh = { ...roster[0], id: 107, slot: 6 }
  t.setTracking(true)
  t.start([...roster, seventh, escort, escortMate])
  t.result([-1, 10, 20, 0, 0, 0, 0, 70], [-1, 30, 40], 7, 2)
  t.send('retreat', { ids: [202] })
  t.send('next', { node: 2 })
  t.result([-1, 10, 20, 0, 0, 0, 0, 10], [-1, 30, -1], 2, 2)
  t.send('next', { node: 3 })
  t.result([-1, 10, 20, 0, 0, 0, 0, 10], [-1, 30, -1], 8, 1)
  t.send('port')
  assert.deepEqual(mvpCounts(t.getSnapshot().last.ships), { 101: 0, 102: 1, 107: 1, 201: 1, 202: 1 })
  t.send('removeShips', { ids: [202] })
  assert.deepEqual(mvpCounts(t.getSnapshot().totals), { 101: 0, 102: 1, 107: 1, 201: 1 })
})

test('legacy unknown MVP stays unknown until a confirmed exercise with the matching fleet', () => {
  const t = setup(new Map([['100', {
    tracking: true, totalSorties: 1, totals: roster.map(ship => ({ ...ship, exp: 55 })),
    last: { kind: 'practice', deckId: 1, battles: 1, ships: roster.map(ship => ({ ...ship, exp: 55 })) },
  }]]))
  assert.deepEqual(mvpCounts(t.getSnapshot().last.ships), { 101: null, 102: null })
  assert.deepEqual(mvpCounts(t.getSnapshot().totals), { 101: null, 102: null })
  t.send('practice', { deckId: 1, roster })
  t.send('practiceResult', { deckId: 2, main: [-1, 40, 50], mvp: 1 })
  assert.equal(t.getSnapshot().totalSorties, 1)
  t.send('practice', { deckId: 1, roster })
  t.send('practiceResult', { deckId: 1, mvp: 2 })
  t.send('port')
  assert.equal(t.getSnapshot().totalSorties, 2)
  assert.equal(t.getSnapshot().last.incomplete, true)
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: null, 102: null })
  assert.deepEqual(mvpCounts(t.getSnapshot().totals), { 101: 0, 102: 1 })
  assert.deepEqual(exp(t.getSnapshot().totals), { 101: 55, 102: 55 })
  t.send('account', { accountId: '200' })
  assert.deepEqual(t.getSnapshot().totals, [])
  assert.deepEqual(mvpCounts(setup(t.store).getSnapshot().totals), { 101: 0, 102: 1 })
})

test('starts at zero, accumulates two battles and commits once at port', () => {
  const t = setup()
  t.setTracking(true)
  t.start()
  assert.deepEqual(exp(t.getSnapshot().current.ships), { 101: 0, 102: 0 })
  t.result([-1, 360, 120])
  t.send('result', { main: [-1, 360, 120] })
  t.send('next', { node: 2 })
  t.send('result', { main: [-1, 360, 120] })
  t.result([-1, 90, 210])
  assert.equal(t.getSnapshot().current.battles, 2)
  assert.deepEqual(exp(t.getSnapshot().current.ships), { 101: 450, 102: 330 })
  assert.equal(t.getSnapshot().totalSorties, 0)
  t.send('port')
  t.send('port')
  assert.equal(t.getSnapshot().current, null)
  assert.equal(t.getSnapshot().last.battles, 2)
  assert.equal(t.getSnapshot().totalSorties, 1)
  assert.deepEqual(exp(t.getSnapshot().totals), { 101: 450, 102: 330 })
})

test('total switch gates future settlements and clear preserves the last run', () => {
  const t = setup()
  t.start()
  t.result([-1, 360, 120])
  t.setTracking(true)
  t.send('next', { node: 2 })
  t.result([-1, 90, 210])
  t.setTracking(false)
  t.send('port')
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: 450, 102: 330 })
  assert.deepEqual(exp(t.getSnapshot().totals), { 101: 90, 102: 210 })
  t.clearTotal()
  assert.equal(t.getSnapshot().totalSorties, 0)
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: 450, 102: 330 })
})

test('each ship retains exactly 9,999,999 EXP, resets on overflow, and counts again next battle', () => {
  const t = setup()
  t.setTracking(true)
  t.start()
  t.result([-1, 9_999_999, 5])
  assert.deepEqual(exp(t.getSnapshot().current.ships), { 101: 9_999_999, 102: 5 })
  t.send('next', { node: 2 })
  t.result([-1, 3, 10])
  assert.deepEqual(exp(t.getSnapshot().current.ships), { 101: 0, 102: 15 })
  t.send('next', { node: 3 })
  t.result([-1, 8, 20])
  assert.deepEqual(exp(t.getSnapshot().current.ships), { 101: 8, 102: 35 })
  t.send('port')
  assert.deepEqual(exp(t.getSnapshot().totals), { 101: 8, 102: 35 })
})

test('total EXP rolls over per tracked battle, but the result commits only on return', () => {
  const t = setup()
  t.setTracking(true)
  t.send('practice', { deckId: 1, roster })
  t.send('practiceResult', { main: [-1, 9_999_998, 8] })
  t.start()
  t.result([-1, 2, 11])
  t.setTracking(false)
  t.send('next', { node: 2 })
  t.result([-1, 30, 18])
  t.setTracking(true)
  t.send('next', { node: 3 })
  t.result([-1, 7, 10])
  assert.deepEqual(exp(t.getSnapshot().totals), { 101: 9_999_998, 102: 8 })
  assert.equal(t.getSnapshot().totalSorties, 1)
  t.send('port')
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: 39, 102: 39 })
  assert.deepEqual(exp(t.getSnapshot().totals), { 101: 7, 102: 29 })
  assert.equal(t.getSnapshot().totalSorties, 2)

  t.send('practice', { deckId: 1, roster })
  t.send('practiceResult', { main: [-1, 10_000_001, 1] })
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: 0, 102: 1 })
  assert.deepEqual(exp(t.getSnapshot().totals), { 101: 0, 102: 30 })
  assert.equal(t.getSnapshot().totalSorties, 3)
})

test('older archives reset and persist only the per-ship EXP already over the limit', () => {
  const [over, atLimit] = roster
  const previous = {
    tracking: true, totalSorties: 40,
    last: { kind: 'sortie', deckId: 1, map: '5-3', battles: 1, incomplete: true,
      ships: [{ ...over, exp: 10_000_002 }, { ...atLimit, exp: null }] },
    totals: [{ ...over, exp: 10_000_002 }, { ...atLimit, exp: 9_999_999 }],
  }
  const t = setup(new Map([['100', previous]]))
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: 0, 102: null })
  assert.deepEqual(t.getSnapshot().totals.map(ship => [ship.id, ship.exp]), [[102, 9_999_999], [101, 0]])
  assert.equal(t.getSnapshot().totalSorties, 40)
  assert.equal(t.store.get('100').totals.find(ship => ship.id === 101).exp, 0)
  assert.equal(previous.totals[0].exp, 10_000_002)
})

test('exercise settles immediately and a later port does not count twice', () => {
  const t = setup()
  t.setTracking(true)
  t.send('practiceResult', { main: [-1, 180, 120] })
  assert.equal(t.getSnapshot().last, null)
  t.send('practice', { deckId: 1, roster })
  assert.equal(t.getSnapshot().current.kind, 'practice')
  t.send('practiceResult', { main: [-1, 180, 120] })
  t.send('practiceResult', { main: [-1, 180, 120] })
  t.send('port')
  assert.equal(t.getSnapshot().totalSorties, 1)
  assert.equal(t.getSnapshot().last.battles, 1)
  assert.equal(t.getSnapshot().last.kind, 'practice')
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: 180, 102: 120 })
})

test('combined fleet uses owned IDs and preserves unknown versus zero', () => {
  const t = setup()
  t.setTracking(true)
  t.start([...roster, escort])
  t.result([-1, 0, 100])
  t.send('port')
  assert.equal(t.getSnapshot().last.incomplete, true)
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: 0, 102: 100, 201: null })
  assert.deepEqual(exp(t.getSnapshot().totals), { 101: 0, 102: 100 })
  t.start([...roster, escort])
  t.result([-1, 20, 30], [-1, 60])
  t.send('retreat', { ids: [201] })
  t.send('next', { node: 2 })
  t.result([-1, 5, 6], [-1, -1])
  t.send('port')
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: 25, 102: 36, 201: 60 })
  assert.equal(t.getSnapshot().last.ships.find(ship => ship.id === 201).retreated, true)
})

test('clear during a run drops pending total, while the run is kept', () => {
  const t = setup()
  t.setTracking(true)
  t.start()
  t.result([-1, 360, 120])
  t.clearTotal()
  t.send('port')
  assert.equal(t.getSnapshot().totalSorties, 0)
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: 360, 102: 120 })
})

test('account switch drops an unfinished run and reloads only that account', () => {
  const t = setup()
  t.setTracking(true)
  t.start()
  t.result([-1, 360, 120])
  t.send('port')
  t.start()
  t.result([-1, 90, 210])
  t.send('account', { accountId: '200' })
  t.send('port')
  assert.equal(t.getSnapshot().totalSorties, 0)
  assert.equal(t.getSnapshot().last, null)
  const reopened = setup(t.store)
  assert.equal(reopened.getSnapshot().tracking, true)
  assert.deepEqual(exp(reopened.getSnapshot().totals), { 101: 360, 102: 120 })
})

test('total ship selection survives reload and account changes without changing accumulated experience', () => {
  const t = setup(new Map([['100', { last: null, tracking: true, totals: [], totalSorties: 0 }]]))
  assert.equal(t.getSnapshot().totalShipSelection, null)
  t.start()
  t.result([-1, 360, 120])
  t.send('port')
  t.setTotalShipSelection([101, 101, -1])
  t.start()
  t.result([-1, 40, 30])
  t.send('port')
  assert.deepEqual(t.getSnapshot().totalShipSelection, [101])
  assert.deepEqual(exp(t.getSnapshot().totals), { 101: 400, 102: 150 })
  assert.equal(t.getSnapshot().totalSorties, 2)
  t.send('account', { accountId: '200' })
  assert.equal(t.getSnapshot().totalShipSelection, null)
  t.setTotalShipSelection([])
  assert.deepEqual(t.getSnapshot().totalShipSelection, [])
  const reopened = setup(t.store)
  assert.deepEqual(reopened.getSnapshot().totalShipSelection, [101])
  reopened.setTotalShipSelection(null)
  assert.equal(setup(t.store).getSnapshot().totalShipSelection, null)
})

test('network interruption requires new navigation before another settlement', () => {
  const t = setup()
  t.start()
  t.result([-1, 100, 50])
  t.send('next', { node: 2 })
  t.send('phase')
  t.send('interrupt')
  t.send('result', { main: [-1, 90, 210] })
  t.send('next', { node: 2 })
  t.result([-1, 40, 20])
  t.send('port')
  assert.equal(t.getSnapshot().last.incomplete, true)
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: 140, 102: 70 })
})

test('removing owned ships purges totals and display choices durably', () => {
  const t = setup()
  t.setTracking(true)
  const clone = { ...roster[0], id: 103, slot: 2 }
  t.start([...roster, clone])
  t.result([-1, 360, 120, 240])
  t.send('port')
  t.setTotalShipSelection([101, 103])
  t.setTracking(false)
  t.send('removeShips', { ids: [101, 101] })
  assert.deepEqual(exp(t.getSnapshot().totals), { 102: 120, 103: 240 })
  assert.deepEqual(t.getSnapshot().totalShipSelection, [103])
  assert.equal(t.getSnapshot().totalSorties, 1)
  assert.equal(t.getSnapshot().last.ships.length, 3)
  const reopened = setup(t.store)
  assert.deepEqual(exp(reopened.getSnapshot().totals), { 102: 120, 103: 240 })
  assert.deepEqual(reopened.getSnapshot().totalShipSelection, [103])
})

test('invalid or other-account removals preserve records', () => {
  const t = setup()
  t.setTracking(true)
  t.start()
  t.result([-1, 360, 120])
  t.send('port')
  for (const ids of [undefined, '101', [], [101, -1], [null], [1.5]]) {
    t.send('removeShips', { ids })
  }
  t.send('removeShips', { accountId: '200', ids: [101] })
  assert.deepEqual(exp(t.getSnapshot().totals), { 101: 360, 102: 120 })
})

test('a removed ship cannot be restored by pending sortie totals', () => {
  const t = setup()
  t.setTracking(true)
  t.start()
  t.result([-1, 360, 120])
  t.send('removeShips', { ids: [101] })
  t.send('port')
  assert.deepEqual(exp(t.getSnapshot().totals), { 102: 120 })
  assert.deepEqual(exp(t.getSnapshot().last.ships), { 101: 360, 102: 120 })
})
