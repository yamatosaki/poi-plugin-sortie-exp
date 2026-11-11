'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createExperience } = require('../src/experience')
const { createPoiAdapter, storagePath } = require('../src/poi-adapter')
const { createShipProjection } = require('../src/poi-ship-data')

test('poi config uses an object key for the account instead of an array index', () => {
  assert.equal(storagePath('987654321'), 'plugin.poi-plugin-sortie-exp.experience.v1.member_987654321')
})

function fixture() {
  const state = {
    info: {
      basic: { api_member_id: '7' },
      fleets: [
        { api_id: 1, api_ship: [101, -1, 102, -1, -1, -1] },
        { api_id: 2, api_ship: [201, -1, -1, -1, -1, -1] },
      ],
      ships: {
        101: { api_ship_id: 10, api_lv: 52, api_exp: [42000, 334, 84], api_nowhp: 17, api_maxhp: 34 },
        102: { api_ship_id: 20, api_lv: 79, api_exp: [90000, 0, 100], api_nowhp: 30, api_maxhp: 30 },
        201: { api_ship_id: 10, api_lv: 93 },
      },
    },
    const: {
      $ships: { 10: { api_name: '夕張', api_stype: 3 }, 20: { api_name: '吹雪' } },
      $shipTypes: { 3: { api_name: '軽巡洋艦' } },
    },
    sortie: { combinedFlag: 0, escapedPos: [] },
  }
  const archives = new Map()
  const tracker = createExperience({ load: id => archives.get(id), save: (id, data) => archives.set(id, data) })
  const adapter = createPoiAdapter({ tracker, getState: () => state })
  let time = 0
  const send = (path, body = {}, postBody = {}, at = ++time) => {
    adapter.onResponse({ path: `/kcsapi/${path}`, body, postBody, time: at })
  }
  const port = (id = '7') => send('api_port/port', { api_basic: { api_member_id: id } })
  const start = at => send('api_req_map/start', { api_no: 1 }, {
    api_deck_id: '1', api_maparea_id: '5', api_mapinfo_no: '3',
  }, at)
  const read = tracker.getSnapshot
  return { state, tracker, adapter, archives, send, port, start, read }
}

test('poi responses preserve roster holes and reject replayed navigation', () => {
  const f = fixture()
  f.start(10)
  assert.equal(f.read().current, null)
  f.port()
  f.start(11)
  f.send('api_req_sortie/battle', { api_deck_id: 1 })
  f.send('api_req_sortie/battleresult', { api_get_ship_exp: [-1, 120, -1, 50], api_mvp: 3 })
  f.start(11)
  f.port()
  assert.equal(f.read().last.map, '5-3')
  assert.deepEqual(f.read().last.ships.map(ship => [ship.id, ship.name, ship.exp, ship.mvpCount]), [
    [101, '夕張', 120, 0], [102, '吹雪', 50, 1],
  ])
})

test('practice uses the selected single fleet and rejects a conflicting result deck', () => {
  const f = fixture()
  f.state.sortie.combinedFlag = 1
  f.port()
  f.tracker.setTracking(true)
  f.send('api_req_practice/battle', { api_deck_id: 2 })
  f.send('api_req_practice/battle_result', { api_deck_id: 1, api_get_ship_exp: [-1, 120] })
  assert.equal(f.read().last, null)
  f.send('api_req_practice/battle', { api_deck_id: 2 })
  f.send('api_req_practice/midnight_battle', {})
  f.send('api_req_practice/battle_result', { api_get_ship_exp: [-1, 180], api_mvp: 1 })
  assert.equal(f.read().totalSorties, 1)
  assert.deepEqual(f.read().last.ships.map(ship => [ship.id, ship.exp, ship.mvpCount]), [[201, 180, 1]])
})

test('combined result and acknowledged evacuation use the original positions', () => {
  const f = fixture()
  f.state.sortie.combinedFlag = 1
  f.port()
  f.start()
  f.send('api_req_combined_battle/battle_water')
  f.send('api_req_combined_battle/battleresult', {
    api_get_ship_exp: [-1, 20, -1, 30], api_get_ship_exp_combined: [-1, 60], api_mvp: 1, api_mvp_combined: 1,
  })
  f.state.sortie.escapedPos = [6]
  f.send('api_req_combined_battle/goback_port')
  f.send('api_req_map/next', { api_no: 2 })
  f.send('api_req_combined_battle/ec_midnight_battle')
  f.send('api_req_combined_battle/battleresult', {
    api_get_ship_exp: [-1, 5, -1, 6], api_get_ship_exp_combined: [-1, -1], api_mvp: 3,
  })
  f.port()
  assert.deepEqual(f.read().last.ships.map(ship => [ship.id, ship.exp, ship.retreated, ship.mvpCount]), [
    [101, 25, false, 1], [102, 36, false, 1], [201, 60, true, 1],
  ])
})

test('a failed response or another account cannot settle the active run', () => {
  const f = fixture()
  f.port()
  f.start()
  f.send('api_req_sortie/battle')
  f.send('api_req_sortie/battleresult', { api_result: 0, api_data: { api_get_ship_exp: [-1, 120, -1, 50] } })
  assert.equal(f.read().current.battles, 0)
  f.send('api_port/port', { api_basic: { api_member_id: '8' } })
  assert.equal(f.read().last, null)
  assert.equal(f.read().current, null)
})

test('an early account switch drops pending work, blocks a stale port, and restores each archive by member ID', () => {
  const f = fixture()
  const practice = reward => {
    f.send('api_req_practice/battle', { api_deck_id: 2 })
    f.send('api_req_practice/battle_result', { api_deck_id: 2, api_get_ship_exp: [-1, reward] })
  }
  const switchTo = id => {
    f.state.info.basic = { api_member_id: id }
    f.send('api_get_member/require_info', { api_basic: { api_member_id: id } })
  }
  f.port()
  f.tracker.setTracking(true)
  practice(120)
  f.send('api_req_practice/battle', { api_deck_id: 2 })
  switchTo('8')
  assert.equal(f.read().accountId, null)
  assert.equal(f.read().current, null)
  f.port('7')
  f.send('api_req_practice/battle_result', { api_deck_id: 2, api_get_ship_exp: [-1, 990] })
  assert.equal(f.read().accountId, null)
  assert.equal(f.archives.get('7').totals[0].exp, 120)

  f.port('8')
  assert.equal(f.read().tracking, false)
  assert.equal(f.read().last, null)
  f.tracker.setTracking(true)
  practice(330)
  f.tracker.setTracking(false)
  switchTo('7')
  f.port()
  assert.equal(f.read().tracking, true)
  assert.equal(f.read().last.ships[0].exp, 120)
  assert.equal(f.read().totals[0].exp, 120)
  switchTo('8')
  f.port('8')
  assert.equal(f.read().tracking, false)
  assert.equal(f.read().last.ships[0].exp, 330)
  assert.equal(f.read().totals[0].exp, 330)
})

test('settlement cannot proceed after the host owner changes or the game restarts', () => {
  const f = fixture()
  f.port()
  f.tracker.setTracking(true)
  f.send('api_req_practice/battle', { api_deck_id: 2 })
  f.state.info.basic = { api_member_id: '8' }
  f.send('api_req_practice/battle_result', { api_deck_id: 2, api_get_ship_exp: [-1, 990] })
  assert.equal(f.read().accountId, null)
  assert.deepEqual(f.archives.get('7').totals, [])

  f.port('8')
  f.start()
  f.adapter.reset()
  f.send('api_req_sortie/battle', { api_deck_id: 1 })
  f.send('api_req_sortie/battleresult', { api_get_ship_exp: [-1, 10, -1, 20] })
  f.port('8')
  assert.equal(f.read().last, null)
})

test('poi supplies actual levels, next-level experience, portraits and damage by owned ship', () => {
  const f = fixture()
  const current = createShipProjection(() => f.state, () => f.read().accountId)
  assert.deepEqual(current(), {})
  f.port()
  f.tracker.setTracking(true)
  f.start()
  const [first, second] = f.read().current.ships
  assert.deepEqual([first.masterId, first.level, first.kind, first.nextExp, first.isDamaged], [10, 52, '軽巡洋艦', 334, true])
  assert.deepEqual([second.masterId, second.level, second.nextExp, second.isDamaged], [20, 79, 0, false])
  const previous = current()
  assert.equal(previous[201].level, 93)
  assert.equal(previous[201].nextExp, undefined)
  assert.strictEqual(current(), previous)

  f.state.info.ships = { ...f.state.info.ships, 101: { api_ship_id: 10, api_lv: 53, api_exp: [46000, 2480, 4] } }
  assert.notStrictEqual(current(), previous)
  assert.equal(current()[101].level, 53)
  assert.equal(current()[101].nextExp, 2480)
  f.send('api_req_sortie/battle')
  f.send('api_req_sortie/battleresult', { api_get_ship_exp: [-1, 100, -1, 50] })
  f.port()
  assert.equal(f.read().last.ships[0].level, 53)
  assert.equal(f.read().last.ships[0].nextExp, 2480)
  assert.equal(f.read().totals[0].nextExp, 2480)
  assert.equal(f.read().last.ships[0].masterId, 10)
  f.state.info.basic = { api_member_id: '8' }
  assert.deepEqual(current(), {})
})

test('older archives retain experience without stored portrait or level metadata', () => {
  const oldShip = { id: 101, name: '夕張', group: 'main', slot: 0, exp: 120 }
  const archived = {
    tracking: true, totalSorties: 1, totals: [oldShip],
    last: { kind: 'sortie', deckId: 1, map: '5-3', battles: 1, incomplete: false, ships: [oldShip] },
  }
  const tracker = createExperience({ load: () => archived })
  tracker.handle({ type: 'account', accountId: '7' })
  assert.equal(tracker.getSnapshot().totalSorties, 1)
  assert.equal(tracker.getSnapshot().last.ships[0].exp, 120)
  const f = fixture()
  const current = createShipProjection(() => f.state, () => tracker.getSnapshot().accountId)
  assert.equal(current()[101].masterId, 10)
  assert.equal(current()[101].level, 52)
})

test('avatar projection responds to poi appearance changes and stays stable without tag data', () => {
  const f = fixture()
  const current = createShipProjection(() => f.state, () => '7', (_owned, _master, tagColors, avatarType) =>
    avatarType === 'tag' ? tagColors[0] : avatarType)
  const previous = current()
  assert.strictEqual(current(), previous)
  f.state.config = { poi: { appearance: { avatarType: 'type' } } }
  assert.equal(current()[101].avatarColor, 'type')
  f.state.config.poi.appearance.avatarType = 'tag'
  assert.equal(current()[101].avatarColor, undefined)
  f.state.fcd = { shiptag: { color: ['#aaccff'] } }
  assert.equal(current()[101].avatarColor, '#aaccff')
})

function seedTotals(f) {
  const totals = [101, 102, 201].map((id, slot) => ({
    id, name: id === 102 ? '吹雪' : '夕張', group: 'main', slot, exp: [360, 120, 240][slot],
  }))
  f.archives.set('7', {
    tracking: true, totalSorties: 3, totals, last: null, totalShipSelection: [101, 201],
  })
  f.port()
}

test('confirmed Poi responses settle supply and repairs from the state before the Redux update', () => {
  const f = fixture()
  const first = { ...f.state.info.ships[101], api_id: 101, api_fuel: 20, api_bull: 20,
    api_slot: [-1], api_onslot: [0], api_ndock_item: [6, 12] }
  const second = { ...f.state.info.ships[102], api_id: 102, api_fuel: 20, api_bull: 20,
    api_slot: [-1], api_onslot: [0], api_ndock_item: [0, 0] }
  f.state.info.ships = { 101: first, 102: second }
  f.state.const.$ships[10] = { ...f.state.const.$ships[10], api_fuel_max: 20, api_bull_max: 20, api_maxeq: [0] }
  f.state.const.$ships[20] = { ...f.state.const.$ships[20], api_fuel_max: 20, api_bull_max: 20, api_maxeq: [0] }
  f.state.info.resources = [100, 100, 100, 100, 0, 10]
  const visitPort = () => f.send('api_port/port', {
    api_basic: { api_member_id: '7' }, api_ship: Object.values(f.state.info.ships),
    api_material: f.state.info.resources.map((api_value, i) => ({ api_id: i + 1, api_value })),
  })
  visitPort()
  f.tracker.setTracking(true)
  f.start()
  f.send('api_req_sortie/battle')
  f.send('api_req_sortie/battleresult', { api_get_ship_exp: [-1, 90, -1, 45], api_mvp: 1 })
  const depleted = { ...first, api_fuel: 15, api_bull: 13 }
  f.state.info.ships = { 101: depleted, 102: second }
  visitPort()
  assert.deepEqual(f.read().resources.pending, { fuel: 5, ammo: 7, steel: 0, bauxite: 0, buckets: 0 })

  f.state.info.ships = { 101: first, 102: second }
  f.state.info.resources = [95, 93, 100, 100, 0, 10]
  const supply = { api_ship: [first], api_material: [95, 93, 100, 100] }
  f.send('api_req_hokyu/charge', supply, { api_id_items: '101' }, 100)
  f.send('api_req_hokyu/charge', supply, { api_id_items: '101' }, 100)
  assert.deepEqual(f.read().resources.byShip[101].supply, { fuel: 5, ammo: 7, steel: 0, bauxite: 0, buckets: 0 })

  f.state.info.ships = { 101: { ...first, api_nowhp: first.api_maxhp }, 102: second }
  f.state.info.resources = [89, 93, 88, 100, 0, 9]
  const repair = { api_ship_id: '101', api_ndock_id: '1', api_highspeed: '1' }
  f.send('api_req_nyukyo/start', {}, repair, 101)
  f.send('api_req_nyukyo/start', {}, repair, 101)
  assert.deepEqual(f.read().resources.confirmed, { fuel: 11, ammo: 7, steel: 12, bauxite: 0, buckets: 1 })
  assert.equal(f.archives.get('7').resourceLedger != null, true)

  f.adapter.reset()
  assert.equal(f.read().resources.hasData, false)
  visitPort()
  assert.equal(f.read().resources.confirmed.buckets, 1)
  f.state.info.basic = { api_member_id: '8' }
  f.port('8')
  assert.equal(f.read().resources.hasData, false)
  f.state.info.basic = { api_member_id: '7' }
  visitPort()
  assert.equal(f.read().resources.confirmed.buckets, 1)
  f.tracker.clearTotal()
  assert.equal(f.read().resources.hasData, false)
  assert.equal(f.archives.get('7').resourceLedger, undefined)
  assert.equal(f.read().last.ships[0].mvpCount, 1)
})

test('confirmed port roster also prunes costs recorded for a removed ship before its first sortie', () => {
  const f = fixture()
  const zeros = { fuel: 0, ammo: 0, steel: 0, bauxite: 0, buckets: 0 }
  const row = { id: 101, name: '夕張', group: 'main', slot: 0, exp: 100 }
  f.archives.set('7', {
    tracking: true, totalSorties: 1, totals: [row], last: null,
    resourceLedger: { version: 1, incomplete: false, unallocated: zeros, ships: [
      { id: 101, supply: zeros, repair: { ...zeros, buckets: 1 }, pending: zeros, incomplete: false },
      { id: 201, supply: zeros, repair: { ...zeros, buckets: 2 }, pending: zeros, incomplete: false },
    ] },
  })
  f.port()
  assert.deepEqual(f.read().resources.shipIds, [101, 201])
  assert.equal(f.read().resources.confirmed.buckets, 1)
  f.send('api_port/port', { api_basic: { api_member_id: '7' }, api_ship: [{ api_id: 101 }] })
  assert.deepEqual(f.read().resources.shipIds, [101])
  f.send('api_req_kousyou/destroyship', {}, { api_ship_id: '101' })
  assert.equal(f.read().resources.hasData, false)
  assert.deepEqual(f.read().totals, [])
  assert.equal(f.archives.get('7').resourceLedger, undefined)
})

test('dismantling removes only confirmed owned IDs, including batch dismantling', () => {
  const f = fixture()
  seedTotals(f)
  f.send('api_req_kousyou/destroyship', { api_result: 0 }, { api_ship_id: '101,102' })
  assert.equal(f.read().totals.length, 3)
  f.send('api_req_kousyou/destroyship', {}, { api_ship_id: '101,invalid' })
  assert.equal(f.read().totals.length, 3)
  delete f.state.info.ships[101]
  delete f.state.info.ships[102]
  f.send('api_req_kousyou/destroyship', {}, { api_ship_id: '101,102' })
  assert.deepEqual(f.read().totals.map(ship => [ship.id, ship.exp]), [[201, 240]])
  assert.deepEqual(f.read().totalShipSelection, [201])
  assert.equal(f.archives.get('7').totals.length, 1)
})

test('modernization removes consumed ships even when the stat improvement fails', () => {
  const f = fixture()
  seedTotals(f)
  f.send('api_req_kaisou/powerup', { api_powerup_flag: 0 }, { api_id: '101', api_id_items: '102,201' })
  assert.equal(f.read().totals.length, 3)
  delete f.state.info.ships[102]
  delete f.state.info.ships[201]
  f.send('api_req_kaisou/powerup', {
    api_powerup_flag: 0, api_ship: { api_id: 101, api_ship_id: 10 },
  }, { api_id: '101', api_id_items: '102,201' })
  assert.deepEqual(f.read().totals.map(ship => [ship.id, ship.exp]), [[101, 360]])
  assert.deepEqual(f.read().totalShipSelection, [101])
})

test('only a complete confirmed port roster reconciles historical records', () => {
  const f = fixture()
  seedTotals(f)
  f.send('api_get_member/ship3', { api_ship_data: [{ api_id: 101 }] })
  f.send('api_get_member/ship_deck', { api_ship_data: [{ api_id: 101 }] })
  f.send('api_get_member/ship2', [{ api_id: 101 }])
  f.send('api_port/port', { api_basic: { api_member_id: '7' }, api_ship: [{}] })
  f.send('api_port/port', { api_basic: { api_member_id: '7' }, api_ship: [{ api_id: 101 }, { api_id: 101 }] })
  assert.equal(f.read().totals.length, 3)
  f.send('api_port/port', { api_basic: { api_member_id: '7' }, api_ship: [{ api_id: 101, api_ship_id: 11 }] })
  assert.deepEqual(f.read().totals.map(ship => [ship.id, ship.exp]), [[101, 360]])
  assert.deepEqual(f.read().totalShipSelection, [101])
  assert.equal(f.read().totalSorties, 3)
  f.send('api_port/port', { api_basic: { api_member_id: '7' }, api_ship: [] })
  assert.deepEqual(f.read().totals, [])
  assert.deepEqual(f.read().totalShipSelection, [])
  assert.equal(f.read().totalSorties, 3)
})

test('returning to port prunes missing ships after settling the sortie', () => {
  const f = fixture()
  f.port()
  f.tracker.setTracking(true)
  f.start()
  f.send('api_req_sortie/battle')
  f.send('api_req_sortie/battleresult', { api_get_ship_exp: [-1, 360, -1, 120] })
  f.send('api_port/port', { api_basic: { api_member_id: '7' }, api_ship: [{ api_id: 102 }] })
  assert.deepEqual(f.read().totals.map(ship => [ship.id, ship.exp]), [[102, 120]])
  assert.equal(f.read().last.ships.length, 2)
  f.state.info.basic.api_member_id = '8'
  f.send('api_req_kousyou/destroyship', {}, { api_ship_id: '102' })
  assert.equal(f.read().accountId, null)
  assert.deepEqual(f.archives.get('7').totals.map(ship => ship.id), [102])
})
