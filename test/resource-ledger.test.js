'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createResourceLedger } = require('../src/resource-ledger')

const material = 'api_get_member/material'
const charge = 'api_req_hokyu/charge'
const repair = 'api_req_nyukyo/start'
const accelerate = 'api_req_nyukyo/speedchange'
const t = 1_800_000_000_000
const ship = (id, overrides) => ({
  api_id: id, api_ship_id: 1, api_lv: id === 101 ? 120 : 98,
  api_nowhp: 12, api_maxhp: 20, api_ndock_item: [6, 12], api_fuel: 20, api_bull: 20,
  api_slot: [id * 2], api_onslot: [8], ...overrides,
})
const state = (ships, extras) => ({
  ships: Object.fromEntries(ships.map(row => [row.api_id, row])),
  masterShips: { 1: { api_fuel_max: 20, api_bull_max: 20, api_maxeq: [8] } },
  resources: { fuel: 1000, ammo: 1000, steel: 1000, bauxite: 1000, buckets: 50 },
  ...extras,
})
const materials = [1, 2, 3, 4].map(api_id => ({ api_id, api_value: 1000 }))
const amounts = (overrides = {}) => ({ fuel: 0, ammo: 0, steel: 0, bauxite: 0, buckets: 0, ...overrides })
const record = (ledger, path, body, before, options = {}) => ledger.record(
  path, body, options.post ?? {}, before, options.at ?? t + 1000, options.tracking ?? true,
)
const balance = (ledger, before) => record(ledger, material, materials, before, { at: t })
const begin = (ledger, ships) => ledger.beginSortie(state(ships), ships.map(row => row.api_id), true)

test('confirmed replenishment reconciles marriage discount and planes in a multi-ship charge', () => {
  const ledger = createResourceLedger()
  begin(ledger, [ship(101), ship(102)])
  assert.equal(ledger.getSnapshot().hasData, false)
  const after = [ship(101, { api_fuel: 10, api_bull: 8, api_onslot: [6] }),
    ship(102, { api_fuel: 14, api_bull: 15, api_onslot: [5] })]
  assert.equal(ledger.returnToPort(after, true), true)
  assert.deepEqual(ledger.getSnapshot().ships[101].pending, amounts({ fuel: 10, ammo: 12, bauxite: 10 }))
  assert.deepEqual(ledger.getSnapshot().total, amounts())
  const before = state(after)
  balance(ledger, before)
  record(ledger, charge, { api_ship: [ship(101), ship(102)], api_material: [986, 985, 1000, 975], api_use_bou: 1 }, before)
  const { ships, pending, total, incomplete } = ledger.getSnapshot()
  assert.deepEqual(ships[101].supply, amounts({ fuel: 8, ammo: 10, bauxite: 10 }))
  assert.deepEqual(ships[102].supply, amounts({ fuel: 6, ammo: 5, bauxite: 15 }))
  assert.deepEqual(pending, amounts())
  assert.deepEqual(total, amounts({ fuel: 14, ammo: 15, bauxite: 25 }))
  assert.equal(incomplete, false)
})

test('ambiguous debits remain unallocated, and partial, mixed, or paused refills cannot overcount', () => {
  const ledger = createResourceLedger()
  begin(ledger, [ship(101), ship(102, { api_fuel: 17 })])
  const before = state([ship(101, { api_fuel: 10 }), ship(102, { api_fuel: 12 })])
  ledger.returnToPort(Object.values(before.ships), true)
  balance(ledger, before)
  record(ledger, charge, { api_ship: [ship(101, { api_fuel: 14 }), ship(102, { api_fuel: 17 })],
    api_material: [992, 1000, 1000, 1000] }, before)
  let snapshot = ledger.getSnapshot()
  assert.equal(snapshot.ships[101].supply.fuel, 3)
  assert.equal(snapshot.ships[101].pending.fuel, 6)
  assert.equal(snapshot.ships[102].supply.fuel, 0)
  assert.equal(snapshot.ships[102].incomplete, true)
  const partial = state([ship(101, { api_fuel: 14 })])
  balance(ledger, partial)
  record(ledger, charge, { api_ship: [ship(101)], api_material: [994, 1000, 1000, 1000] }, partial)
  snapshot = ledger.getSnapshot()
  assert.equal(snapshot.total.fuel, 3)
  assert.equal(snapshot.unallocated.fuel, 6)
  assert.equal(snapshot.incomplete, true)
  begin(ledger, [ship(101)])
  ledger.returnToPort([ship(101, { api_fuel: 10 })], true)
  const paused = state([ship(101, { api_fuel: 10 })])
  balance(ledger, paused)
  record(ledger, charge, { api_ship: [ship(101)], api_material: [992, 1000, 1000, 1000] }, paused, { tracking: false })
  assert.equal(ledger.getSnapshot().total.fuel, 3)
  assert.equal(ledger.getSnapshot().pending.fuel, 0)
})

test('repair admission books fuel and steel, instant repair and speedchange each book the correct bucket', () => {
  const ledger = createResourceLedger()
  const roster = [ship(101), ship(102)]
  ledger.returnToPort(roster, true)
  const before = state(roster)
  record(ledger, repair, null, before, { post: { api_ship_id: '101', api_ndock_id: '1', api_highspeed: '0' } })
  record(ledger, repair, null, before, { post: { api_ship_id: '102', api_ndock_id: '2', api_highspeed: '1' } })
  assert.deepEqual(ledger.getSnapshot().ships[101].repair, amounts({ fuel: 6, steel: 12 }))
  assert.deepEqual(ledger.getSnapshot().ships[102].repair, amounts({ fuel: 6, steel: 12, buckets: 1 }))
  const dock = state(roster, { repairDocks: [{ api_id: 1, api_state: 1, api_ship_id: 101 }] })
  const speedOptions = { post: { api_ndock_id: '1' } }
  record(ledger, accelerate, null, dock, speedOptions)
  assert.equal(record(ledger, accelerate, null, state(roster), speedOptions), false)
  assert.deepEqual(ledger.getSnapshot([101]).total, amounts({ fuel: 6, steel: 12, buckets: 1 }))
  assert.equal(ledger.getSnapshot().incomplete, false)
})

test('a stale repair quote retains the confirmed bucket, and stale warehouse balances never create charges', () => {
  const ledger = createResourceLedger()
  ledger.returnToPort([ship(101)], true)
  const differentHp = state([ship(101, { api_nowhp: 9 })])
  record(ledger, repair, null, differentHp, { post: { api_ship_id: '101', api_ndock_id: '1', api_highspeed: '1' } })
  assert.deepEqual(ledger.getSnapshot().ships[101].repair, amounts({ buckets: 1 }))
  assert.equal(ledger.getSnapshot().incomplete, true)
  begin(ledger, [ship(101)])
  const after = ship(101, { api_fuel: 10 })
  ledger.returnToPort([after], true)
  const before = state([after])
  balance(ledger, before)
  record(ledger, charge, { api_ship: [ship(101)], api_material: [992, 1000, 1000, 1000] }, before,
    { at: t + 120_001 })
  assert.deepEqual(ledger.getSnapshot().total, amounts({ buckets: 1 }))
  assert.deepEqual(ledger.getSnapshot().unallocated, amounts())
})

test('offshore supply and equipment changes invalidate only the relevant pending parts', () => {
  const ledger = createResourceLedger()
  begin(ledger, [ship(101), ship(102)])
  const after = [ship(101, { api_fuel: 12, api_bull: 14, api_onslot: [6] }),
    ship(102, { api_fuel: 12, api_onslot: [5] })]
  ledger.returnToPort(after, true)
  ledger.observeOffshoreSupply([101], false)
  record(ledger, 'api_req_kaisou/slotset', null, state(after), { post: { api_id: '102' } })
  const snapshot = ledger.getSnapshot()
  assert.deepEqual(snapshot.ships[101].pending, amounts({ bauxite: 10 }))
  assert.deepEqual(snapshot.ships[102].pending, amounts({ fuel: 8 }))
  assert.equal(snapshot.incomplete, true)
})

test('restore and interruption keep confirmed data but retire unverified pending attribution', () => {
  const ledger = createResourceLedger()
  begin(ledger, [ship(101)])
  const after = ship(101, { api_fuel: 10, api_bull: 8 })
  ledger.returnToPort([after], true)
  const before = state([after])
  balance(ledger, before)
  record(ledger, charge, { api_ship: [ship(101, { api_bull: 8 })], api_material: [992, 1000, 1000, 1000] }, before)
  assert.equal(ledger.getSnapshot().pending.ammo, 12)
  const restored = createResourceLedger(ledger.toJSON())
  assert.equal(restored.getSnapshot().total.fuel, 8)
  assert.deepEqual(restored.getSnapshot().pending, amounts())
  assert.equal(restored.getSnapshot().incomplete, true)
  assert.equal(restored.forgetShips([101]), true)
  assert.equal(restored.getSnapshot().hasData, false)
  assert.equal(ledger.interrupt(), true)
  assert.equal(ledger.getSnapshot().total.fuel, 8)
  assert.deepEqual(ledger.getSnapshot().pending, amounts())
  ledger.clear()
  assert.equal(ledger.getSnapshot().hasData, false)
  assert.equal(createResourceLedger(null).getSnapshot().hasData, false)
  assert.equal(createResourceLedger({ ships: 'invalid' }).getSnapshot().incomplete, true)
})
