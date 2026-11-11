'use strict'

const resourceKeys = Object.freeze(['fuel', 'ammo', 'steel', 'bauxite', 'buckets'])
const supplyKeys = ['fuel', 'ammo', 'bauxite']
const materialKeys = ['fuel', 'ammo', 'steel', 'bauxite', null, 'buckets']
const port = 'api_port/port'
const material = 'api_get_member/material'
const charge = 'api_req_hokyu/charge'
const repair = 'api_req_nyukyo/start'
const accelerate = 'api_req_nyukyo/speedchange'
const practice = 'api_req_practice/battle'
const mission = 'api_req_mission/start'
const rosterPaths = new Set(['api_get_member/ship2', 'api_get_member/ship3', 'api_get_member/ship_deck'])
const materialChangePaths = new Set([
  'api_req_mission/result', 'api_req_quest/clearitemget', 'api_req_member/itemuse',
  'api_req_air_corps/supply', 'api_req_air_corps/set_plane', 'api_req_air_corps/change_deployment_base',
  'api_req_kousyou/createship', 'api_req_kousyou/createitem', 'api_req_kousyou/destroyitem2',
  'api_req_kousyou/destroyship', 'api_req_kousyou/remodel_slot', 'api_req_kousyou/remodel_slot_recover',
  'api_req_kaisou/marriage', 'api_req_kaisou/powerup', 'api_req_map/start', 'api_req_map/air_raid',
])
const equipmentPaths = new Set([
  'api_req_kaisou/slotset', 'api_req_kaisou/unsetslot_all', 'api_req_kaisou/slot_deprive',
  'api_req_kaisou/slot_exchange_index',
])
const supportedPaths = new Set([
  port, material, charge, repair, accelerate, practice, mission,
  ...rosterPaths, ...materialChangePaths, ...equipmentPaths,
])
const supportsResourcePath = path => supportedPaths.has(path)

const bound = amount => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, amount))
const storedInt = value => Number.isSafeInteger(value) && value >= 0
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function wireInt(value) {
  const number = typeof value === 'string' && /^\+?\d+$/.test(value.trim()) ? Number(value) : value
  return storedInt(number) ? number : null
}

function amounts(values = {}) {
  return Object.fromEntries(resourceKeys.map(key => [key, values[key] ?? 0]))
}

function readAmounts(values) {
  return isObject(values) && resourceKeys.every(key => storedInt(values[key])) ? amounts(values) : null
}

const isEmpty = values => resourceKeys.every(key => values[key] === 0)
const add = (first, second) => Object.fromEntries(resourceKeys.map(key => [key, bound(first[key] + second[key])]))
const equal = (first, second) => resourceKeys.every(key => first[key] === second[key])
const emptySpending = () => ({ supply: amounts(), repair: amounts(), pending: amounts(), incomplete: false })

function shipRows(value) {
  if (!Array.isArray(value)) return null
  const rows = new Map()
  for (const row of value) {
    const id = wireInt(row?.api_id)
    if (!isObject(row) || !id || rows.has(id)) return null
    rows.set(id, row)
  }
  return rows
}

function numberList(value, slots = false) {
  if (!Array.isArray(value)) return null
  const result = Array.from(value, entry => slots && entry === -1 ? -1 : wireInt(entry))
  return result.includes(null) ? null : result
}

const sameList = (first, second) => first.length === second.length && first.every((value, index) => value === second[index])
const difference = (more, less) => more == null || less == null || more < less ? null : more - less
const planeValue = counts => counts.reduce((total, count) => bound(total + count * 5), 0)

function planeStock(slots, counts) {
  return slots && counts && slots.length === counts.length ? { slots, counts } : null
}

function planeDifference(more, less) {
  if (!more || !less || !sameList(more.slots, less.slots)) return null
  const counts = more.counts.map((count, index) => difference(count, less.counts[index]))
  return counts.includes(null) ? null : { slots: more.slots, counts }
}

function wireStock(row) {
  return {
    fuel: wireInt(row?.api_fuel), ammo: wireInt(row?.api_bull),
    aircraft: planeStock(numberList(row?.api_slot, true), numberList(row?.api_onslot)),
  }
}

function masterFor(before, ship) {
  return before.masterShips?.[wireInt(ship?.api_ship_id)]
}

function sortieStock(before, ship) {
  const stock = wireStock(ship)
  const master = masterFor(before, ship)
  return {
    fuel: stock.fuel > 0 || wireInt(master?.api_fuel_max) > 0 ? stock.fuel : null,
    ammo: stock.ammo > 0 || wireInt(master?.api_bull_max) > 0 ? stock.ammo : null,
    aircraft: stock.aircraft,
  }
}

const hasAircraftBaseline = stock => stock.aircraft?.counts.some(count => count > 0) ?? false
const hasSupplyBaseline = stock => stock.fuel !== null || stock.ammo !== null || hasAircraftBaseline(stock)

function warehouseAmount(before, key) {
  const resources = before.resources
  return wireInt(Array.isArray(resources) ? resources[materialKeys.indexOf(key)] : resources?.[key])
}

function indexedMaterial(value) {
  if (!Array.isArray(value)) return {}
  const result = {}
  for (const row of value) {
    if (!isObject(row)) return {}
    const key = materialKeys[(wireInt(row.api_id) ?? 0) - 1]
    if (!key) continue
    const amount = wireInt(row.api_value)
    if (amount === null || result[key] !== undefined) return {}
    result[key] = amount
  }
  return result
}

function positionalMaterial(value) {
  if (!Array.isArray(value) || value.length < 4) return {}
  const result = {}
  for (const key of resourceKeys.slice(0, 4)) {
    const amount = wireInt(value[materialKeys.indexOf(key)])
    if (amount === null) return {}
    result[key] = amount
  }
  return result
}

function createResourceLedger(raw) {
  const ships = new Map()
  const planeDebt = new Map()
  const repairQuotes = new Map()
  const acceleratedDocks = new Set()
  let active = null
  let warehouse = {}
  let warehouseAt = null
  let incomplete = false
  let unallocated = amounts()

  function put(id, next) {
    if (isEmpty(next.supply) && isEmpty(next.repair) && isEmpty(next.pending) && !next.incomplete) {
      return ships.delete(id)
    }
    const prior = ships.get(id)
    if (prior && prior.incomplete === next.incomplete && equal(prior.supply, next.supply) &&
        equal(prior.repair, next.repair) && equal(prior.pending, next.pending)) return false
    ships.set(id, next)
    return true
  }

  function restore(value) {
    if (value == null) return
    if (!isObject(value) || value.version !== 1 || !Array.isArray(value.ships)) {
      incomplete = true
      return
    }
    const restoredUnallocated = readAmounts(value.unallocated)
    incomplete = value.incomplete !== false || restoredUnallocated === null
    if (restoredUnallocated) unallocated = restoredUnallocated
    const seen = new Set()
    for (const row of value.ships) {
      const id = row?.id
      if (!isObject(row) || typeof row.incomplete !== 'boolean' || !storedInt(id) || id === 0 || seen.has(id)) {
        if (seen.has(id)) ships.delete(id)
        incomplete = true
        continue
      }
      seen.add(id)
      const supply = readAmounts(row.supply)
      const repair = readAmounts(row.repair)
      const pending = readAmounts(row.pending)
      if (!supply || !repair || !pending) {
        incomplete = true
        continue
      }
      // The old fuel and plane deficits cannot be proven after capture restarts.
      put(id, { supply, repair, pending: amounts(), incomplete: row.incomplete || !isEmpty(pending) })
    }
  }

  function markIncomplete() {
    const changed = !incomplete
    incomplete = true
    return changed
  }

  function invalidatePending(id) {
    const prior = ships.get(id)
    if (!prior || isEmpty(prior.pending)) return false
    planeDebt.delete(id)
    return put(id, { ...prior, pending: amounts(), incomplete: true })
  }

  function setWarehouse(values, at) {
    warehouse = values
    warehouseAt = Object.keys(values).length && Number.isFinite(at) ? at : null
  }

  function observeRepairQuotes(value) {
    for (const [id, row] of shipRows(value) ?? []) {
      const hp = wireInt(row.api_nowhp)
      if (!Object.hasOwn(row, 'api_ndock_item')) {
        if (hp !== null && repairQuotes.get(id)?.hp !== hp) repairQuotes.delete(id)
        continue
      }
      const costs = numberList(row.api_ndock_item)
      if (hp === null || !costs || ![0, 2].includes(costs.length)) repairQuotes.delete(id)
      else repairQuotes.set(id, { hp, fuel: costs[0] ?? 0, steel: costs[1] ?? 0 })
    }
  }

  function beginSortie(before, shipIds, tracking) {
    active = tracking ? new Map() : null
    if (!active) return
    for (const id of shipIds) {
      const ship = before.ships?.[id]
      if (ship) active.set(id, sortieStock(before, ship))
    }
  }

  function returnToPort(value, tracking) {
    const underway = active
    active = null
    observeRepairQuotes(value)
    if (!tracking || !underway?.size) return false
    const rows = shipRows(value)
    let changed = false
    for (const [id, start] of underway) {
      const previous = ships.get(id) ?? emptySpending()
      const row = rows?.get(id)
      if (!row) {
        if (hasSupplyBaseline(start)) changed = put(id, { ...previous, incomplete: true }) || changed
        changed = invalidatePending(id) || changed
        continue
      }
      const end = wireStock(row)
      const fuel = difference(start.fuel, end.fuel)
      const ammo = difference(start.ammo, end.ammo)
      const aircraft = planeDifference(start.aircraft, end.aircraft)
      const priorAircraft = planeDebt.get(id)
      const aircraftValid = aircraft && (!priorAircraft || sameList(aircraft.slots, priorAircraft.slots))
      let bauxite = 0
      if (aircraftValid) {
        const counts = aircraft.counts.map((count, index) => bound(count + (priorAircraft?.counts[index] ?? 0)))
        bauxite = planeValue(counts)
        if (bauxite > 0) planeDebt.set(id, { slots: aircraft.slots, counts })
      }
      if (bauxite === 0) planeDebt.delete(id)
      const pending = amounts({
        fuel: fuel === null ? 0 : bound(previous.pending.fuel + fuel),
        ammo: ammo === null ? 0 : bound(previous.pending.ammo + ammo),
        bauxite,
      })
      changed = put(id, {
        ...previous, pending,
        incomplete: previous.incomplete ||
          (fuel === null && (previous.pending.fuel > 0 || (start.fuel !== null && end.fuel === null))) ||
          (ammo === null && (previous.pending.ammo > 0 || (start.ammo !== null && end.ammo === null))) ||
          (!aircraftValid && (previous.pending.bauxite > 0 || hasAircraftBaseline(start))),
      }) || changed
    }
    return changed
  }

  function observeOffshoreSupply(ids, tracking) {
    active = null
    const affected = new Set(ids)
    let changed = tracking && markIncomplete()
    for (const id of affected.size ? affected : ships.keys()) {
      const prior = ships.get(id)
      if (!prior || (!prior.pending.fuel && !prior.pending.ammo)) continue
      changed = put(id, { ...prior, pending: amounts({ bauxite: prior.pending.bauxite }), incomplete: true }) || changed
    }
    return changed
  }

  function matchesPlaneDebt(id, ship, refill, before, master) {
    const pending = planeDebt.get(id)
    if (!pending || !refill || !ship || !sameList(pending.slots, refill.slots) ||
        !sameList(pending.counts, refill.counts)) return false
    const capacities = ship.api_onslot_max?.length ? ship.api_onslot_max : master?.api_maxeq
    return refill.counts.every((count, index) => {
      if (!count) return true
      const item = before.slotItems?.[refill.slots[index]]
      const type = before.masterSlotItems?.[item?.api_slotitem_id]?.api_type
      const capacity = wireInt(type?.[2]) === 41 ? 1 : wireInt(capacities?.[index])
      const stock = wireInt(ship.api_onslot?.[index])
      return capacity !== null && stock !== null && stock + count === capacity
    })
  }

  function reconcileCharge(key, rows, before, debit, tracking) {
    const candidates = new Map()
    const eligible = new Set()
    const maximum = key === 'fuel' ? 'api_fuel_max' : 'api_bull_max'
    let changed = false
    for (const { id, ship, current, after, planeRefill } of rows) {
      const master = masterFor(before, ship)
      const refill = key === 'bauxite' ? planeRefill && planeValue(planeRefill.counts)
        : difference(after[key], current[key])
      const discount = key !== 'bauxite' && wireInt(ship?.api_lv) > 99 && refill > 0
      candidates.set(id, discount ? Math.max(1, Math.floor(refill * 85 / 100)) : refill)
      const prior = ships.get(id)
      const owed = prior?.pending[key] ?? 0
      if (!owed || refill === 0) continue
      const cleanDeficit = key === 'bauxite' ? matchesPlaneDebt(id, ship, planeRefill, before, master)
        : difference(wireInt(master?.[maximum]), current[key]) === owed
      const reconciled = cleanDeficit && refill !== null && refill <= owed
      if (reconciled) eligible.add(id)
      if (key === 'bauxite') planeDebt.delete(id)
      changed = put(id, {
        ...prior, pending: { ...prior.pending, [key]: reconciled ? owed - refill : 0 },
        incomplete: prior.incomplete || (tracking && (refill === null || (refill <= owed && !reconciled))),
      }) || changed
    }
    if (!tracking || !eligible.size) return changed
    const debits = [...candidates.values()]
    const balanced = debit !== null && debits.every(value => value !== null) &&
      debits.reduce((sum, value) => sum + value, 0) === debit
    if (!balanced && debit > 0 && [...candidates].every(([id, value]) => value === 0 || eligible.has(id))) {
      unallocated = add(unallocated, amounts({ [key]: debit }))
      changed = true
    }
    for (const id of eligible) {
      const prior = ships.get(id) ?? emptySpending()
      changed = put(id, balanced
        ? { ...prior, supply: add(prior.supply, amounts({ [key]: candidates.get(id) })) }
        : { ...prior, incomplete: true }) || changed
    }
    return changed
  }

  function recordCharge(body, before, at, tracking) {
    const previous = warehouse
    const previousAt = warehouseAt
    const after = positionalMaterial(body?.api_material)
    setWarehouse(after, at)
    const wireRows = shipRows(body?.api_ship)
    let changed = false
    if (!wireRows) {
      for (const id of ships.keys()) changed = invalidatePending(id) || changed
      return changed
    }
    const rows = Array.from(wireRows, ([id, row]) => {
      const ship = before.ships?.[id]
      const current = wireStock(ship)
      const aircraft = current.aircraft
      const planeRefill = aircraft
        ? planeDifference(planeStock(aircraft.slots, numberList(row.api_onslot)), aircraft) : null
      return { id, ship, current, after: wireStock(row), planeRefill }
    })
    const fresh = previousAt !== null && at >= previousAt && at - previousAt <= 120_000
    for (const key of supplyKeys) {
      // api_use_bou is a flag. Verify the actual warehouse debit against the fleet's refills.
      const debit = fresh && warehouseAmount(before, key) === previous[key]
        ? difference(previous[key], after[key]) : null
      changed = reconcileCharge(key, rows, before, debit, tracking) || changed
    }
    return changed
  }

  function addRepair(id, values, unknown = false) {
    const prior = ships.get(id) ?? emptySpending()
    return put(id, { ...prior, repair: add(prior.repair, values), incomplete: prior.incomplete || unknown })
  }

  function recordRepair(post, before, at, tracking) {
    const id = wireInt(post.api_ship_id)
    const dock = wireInt(post.api_ndock_id)
    const instant = wireInt(post.api_highspeed)
    const ship = before.ships?.[id]
    if (!ship || !id || !dock || (instant !== 0 && instant !== 1)) {
      setWarehouse({}, at)
      return tracking && markIncomplete()
    }
    const hp = wireInt(ship.api_nowhp)
    const maxHp = wireInt(ship.api_maxhp)
    const alreadyDocked = Object.values(before.repairDocks ?? {}).some(row =>
      wireInt(row?.api_id) === dock && wireInt(row.api_ship_id) === id && wireInt(row.api_state) === 1)
    if ((maxHp > 0 && hp >= maxHp) || alreadyDocked) return false
    acceleratedDocks.delete(dock)
    const quote = repairQuotes.get(id)
    repairQuotes.delete(id)
    const costs = numberList(ship.api_ndock_item)
    const fresh = quote && costs && (costs.length === 2 || costs.length === 0) &&
      quote.hp === hp && quote.fuel === (costs[0] ?? 0) && quote.steel === (costs[1] ?? 0)
    const fuel = fresh ? quote.fuel : null
    const steel = fresh ? quote.steel : null
    if (warehouse.fuel !== undefined) {
      if (fuel !== null && warehouse.fuel >= fuel && warehouseAmount(before, 'fuel') === warehouse.fuel) {
        warehouse.fuel -= fuel
      } else delete warehouse.fuel
    }
    return tracking && addRepair(id, amounts({ fuel, steel, buckets: instant }), fuel === null || steel === null)
  }

  function recordAcceleration(post, before, tracking) {
    const dock = wireInt(post.api_ndock_id)
    if (acceleratedDocks.has(dock)) return false
    const row = Object.values(before.repairDocks ?? {}).find(entry =>
      wireInt(entry?.api_id) === dock && wireInt(entry.api_state) === 1)
    const id = wireInt(row?.api_ship_id)
    if (!id) return tracking && markIncomplete()
    acceleratedDocks.add(dock)
    return tracking && addRepair(id, amounts({ buckets: 1 }))
  }

  function observeEquipment(body, post) {
    const rawRows = body?.api_ship_data
    const rows = shipRows(isObject(rawRows) ? Object.values(rawRows) : rawRows)
    const affected = new Set([
      wireInt(post.api_id), wireInt(post.api_ship_id), wireInt(post.api_set_ship),
      wireInt(post.api_unset_ship), ...(rows?.keys() ?? []),
    ])
    let changed = false
    for (const id of affected) {
      if (!planeDebt.delete(id)) continue
      const prior = ships.get(id)
      changed = put(id, { ...prior, pending: { ...prior.pending, bauxite: 0 }, incomplete: true }) || changed
    }
    return changed
  }

  function record(path, body, post = {}, before = {}, at = Date.now(), tracking = false) {
    if (path === charge) return recordCharge(body, before, at, tracking)
    if (path === repair) return recordRepair(post, before, at, tracking)
    if (path === accelerate) return recordAcceleration(post, before, tracking)
    if (path === port || path === material) setWarehouse(indexedMaterial(path === port ? body?.api_material : body), at)
    else if (path === practice || path === mission) {
      const deck = wireInt(post.api_deck_id) ?? wireInt(body?.api_deck_id)
      const fleet = Object.values(before.fleets ?? {}).find(row => wireInt(row?.api_id) === deck)
      let changed = false
      for (const rawId of fleet?.api_ship ?? []) changed = invalidatePending(wireInt(rawId)) || changed
      return changed
    } else if (rosterPaths.has(path)) {
      observeRepairQuotes(Array.isArray(body) ? body : body?.api_ship_data ?? body?.api_ship ?? body?.api_ship_data_list)
    } else if (equipmentPaths.has(path)) return observeEquipment(body, post)
    else if (materialChangePaths.has(path)) setWarehouse({}, at)
    return false
  }

  function getSnapshot(ids = ships.keys()) {
    const selected = {}
    let total = amounts()
    let pending = amounts()
    for (const id of new Set(ids)) {
      const row = ships.get(id)
      if (!row) continue
      const spent = add(row.supply, row.repair)
      selected[id] = { supply: { ...row.supply }, repair: { ...row.repair }, pending: { ...row.pending },
        incomplete: row.incomplete, total: spent }
      total = add(total, spent)
      pending = add(pending, row.pending)
    }
    return {
      ships: selected, total, pending, unallocated: { ...unallocated },
      hasData: ships.size > 0 || incomplete || !isEmpty(unallocated),
      incomplete: incomplete || [...ships.values()].some(row => row.incomplete),
    }
  }

  restore(raw)
  return {
    beginSortie, returnToPort, observeOffshoreSupply, record, getSnapshot,
    shipIds: () => [...ships.keys()],
    abandonSortie: () => { active = null },
    interrupt() {
      let changed = Boolean(active?.size) && markIncomplete()
      active = null
      setWarehouse({}, null)
      repairQuotes.clear()
      acceleratedDocks.clear()
      for (const id of ships.keys()) changed = invalidatePending(id) || changed
      return changed
    },
    forgetShips(ids) {
      let changed = false
      for (const id of ids) {
        active?.delete(id)
        planeDebt.delete(id)
        repairQuotes.delete(id)
        changed = ships.delete(id) || changed
      }
      return changed
    },
    clear() {
      active = null
      ships.clear()
      planeDebt.clear()
      unallocated = amounts()
      incomplete = false
    },
    toJSON() {
      return {
        version: 1, incomplete, unallocated: { ...unallocated },
        ships: [...ships].map(([id, row]) => ({ id, ...row, supply: { ...row.supply },
          repair: { ...row.repair }, pending: { ...row.pending } })),
      }
    },
  }
}

module.exports = { createResourceLedger, supportsResourcePath, resourceKeys }
