'use strict'

const emptyArchive = () => ({ last: null, tracking: false, totals: [], totalSorties: 0 })
const copy = value => JSON.parse(JSON.stringify(value))
const maxShipExp = 9_999_999
const isExp = value => Number.isSafeInteger(value) && value >= 0
const addShipExp = (previous, reward) => reward > maxShipExp - previous ? 0 : previous + reward
const byExp = (a, b) => b.exp - a.exp || a.id - b.id
const isShip = ship => ship && Number.isSafeInteger(ship.id) && ship.id > 0 &&
  typeof ship.name === 'string' && ['main', 'escort'].includes(ship.group) &&
  Number.isSafeInteger(ship.slot) && ship.slot >= 0 && ship.slot < 7

function makeRun(kind, event) {
  const { deckId, map, node, roster } = event
  if (!Number.isSafeInteger(deckId) || deckId < 1 || !Array.isArray(roster) ||
      !roster.length || !roster.every(isShip) ||
      new Set(roster.map(ship => ship.id)).size !== roster.length ||
      new Set(roster.map(ship => `${ship.group}:${ship.slot}`)).size !== roster.length) return null
  if (kind === 'sortie' && (!/^\d+-\d+$/.test(map) || !Number.isSafeInteger(node) || node < 1)) return null
  return {
    kind, deckId, map: kind === 'sortie' ? map : null, node, battles: 0,
    incomplete: event.incomplete === true, expectsEscort: event.expectsEscort === true,
    ships: roster.map(ship => ({ ...ship, exp: 0, retreated: false })),
    phase: kind === 'practice' ? 'ready' : 'waiting', known: new Set(), pendingTotals: new Map(),
  }
}

function snapshot(run) {
  if (!run) return null
  const { kind, deckId, map, battles, incomplete, ships } = run
  return { kind, deckId, map, battles, incomplete, ships: ships.map(ship => ({
    ...ship, exp: battles > 0 && !run.known.has(ship.id) ? null : ship.exp,
  })) }
}

function decodeRewards(ships, group, raw) {
  const fleet = ships.filter(ship => ship.group === group)
  if (!fleet.length) return new Map()
  if (!Array.isArray(raw) || raw[0] !== -1) return null
  const bySlot = new Map(fleet.map(ship => [ship.slot, ship]))
  if (fleet.some(ship => !ship.retreated && ship.slot + 1 >= raw.length)) return null

  const rewards = new Map()
  for (let index = 1; index < raw.length; index += 1) {
    const ship = bySlot.get(index - 1)
    const value = raw[index]
    if (ship && !ship.retreated) {
      if (!isExp(value)) return null
      rewards.set(ship.id, value)
    } else if (value !== -1 && value !== 0) return null
  }
  return rewards
}

function restoreArchive(raw) {
  if (raw == null) return emptyArchive()
  const validRow = ship => isShip(ship) && isExp(ship.exp)
  const validLast = raw.last === null || (raw.last &&
    ['sortie', 'practice'].includes(raw.last.kind) && isExp(raw.last.battles) &&
    Array.isArray(raw.last.ships) && raw.last.ships.every(ship =>
      isShip(ship) && (ship.exp === null || isExp(ship.exp))))
  if (typeof raw.tracking !== 'boolean' || !isExp(raw.totalSorties) ||
      !Array.isArray(raw.totals) || !raw.totals.every(validRow) || !validLast) {
    throw new Error('Invalid sortie experience archive')
  }
  return copy(raw)
}

function createExperience({ load = () => null, save = () => {}, notify = () => {} } = {}) {
  let archive = emptyArchive()
  let accountId = null
  let current = null
  let readFailed = false
  let dirty = false
  let storageError = false
  let view

  function update() {
    view = {
      accountId,
      accountReady: accountId !== null,
      current: snapshot(current),
      last: archive.last,
      tracking: archive.tracking,
      totals: archive.totals,
      totalSorties: archive.totalSorties,
      storageError,
    }
    notify(view)
  }

  function persist() {
    if (!accountId || !dirty || readFailed) return
    try {
      save(accountId, copy(archive))
      dirty = false
      storageError = false
    } catch (_) {
      storageError = true
    }
  }

  function changeAccount(id) {
    if (id === accountId) return false
    persist()
    current = null
    accountId = id
    archive = emptyArchive()
    dirty = false
    readFailed = false
    storageError = false
    if (id) {
      try {
        archive = restoreArchive(load(id))
        for (const ship of [...archive.totals, ...(archive.last?.ships ?? [])]) {
          if (ship.exp <= maxShipExp) continue
          ship.exp = 0
          dirty = true
        }
        if (dirty) archive.totals.sort(byExp)
      } catch (_) {
        readFailed = true
        storageError = true
      }
    }
    return true
  }

  function reward(run, values) {
    for (const ship of run.ships) {
      const value = values.get(ship.id)
      if (value === undefined) continue
      run.known.add(ship.id)
      ship.exp = addShipExp(ship.exp, value)
      if (archive.tracking) {
        // Stage each settlement so a later battle can count again after a reset.
        const total = run.pendingTotals.get(ship.id) ?? archive.totals.find(row => row.id === ship.id)?.exp ?? 0
        run.pendingTotals.set(ship.id, addShipExp(total, value))
      }
    }
  }

  function finish(shipDisplay) {
    const totalById = new Map(archive.totals.map(ship => [ship.id, ship]))
    for (const ship of current.ships) {
      const observed = shipDisplay?.[ship.id]
      if (observed && (ship.masterId === undefined || observed.masterId === ship.masterId)) {
        Object.assign(ship, observed)
      }
      const value = current.pendingTotals.get(ship.id)
      if (value === undefined) continue
      const previous = totalById.get(ship.id)
      totalById.set(ship.id, { ...previous, ...ship, exp: value, retreated: false })
    }
    archive = {
      ...archive,
      last: snapshot(current),
      totals: [...totalById.values()].sort(byExp),
      totalSorties: archive.totalSorties + Number(current.pendingTotals.size > 0),
    }
    current = null
    dirty = true
  }

  function accept(event) {
    const { type } = event
    if (type === 'account') return changeAccount(/^\d+$/.test(event.accountId ?? '') && Number(event.accountId) > 0 ? String(event.accountId) : null)
    if (!accountId) return false
    if (event.accountId != null && String(event.accountId) !== accountId) return false
    if (type === 'sortie' || type === 'practice') {
      current = makeRun(type, event)
      return true
    }
    if (!current) return false
    if (type === 'interrupt') {
      if (current.kind === 'practice') current = null
      else {
        current.incomplete = true
        current.phase = 'interrupted'
      }
      return true
    }
    if (type === 'port') {
      if (current.kind === 'sortie') {
        if (current.phase === 'ready') current.incomplete = true
        finish(event.shipDisplay)
      } else current = null
      return true
    }
    if (type === 'practiceResult' && current.kind === 'practice') {
      const values = decodeRewards(current.ships, 'main', event.main)
      if (values?.size && (event.deckId == null || event.deckId === current.deckId)) {
        current.battles = 1
        reward(current, values)
        finish(event.shipDisplay)
      } else current = null
      return true
    }
    if (type === 'practiceNight' && current.kind === 'practice' &&
        event.deckId != null && event.deckId !== current.deckId) {
      current = null
      return true
    }
    if (current.kind !== 'sortie') return false
    if (type === 'next') {
      if (!Number.isSafeInteger(event.node) || event.node < 1 ||
          (event.map && event.map !== current.map)) {
        current.incomplete = true
        current.phase = 'interrupted'
        return true
      }
      if (current.node === event.node && current.phase !== 'interrupted') return false
      if (current.phase === 'ready') current.incomplete = true
      current.node = event.node
      current.phase = 'waiting'
      return true
    }
    if (type === 'phase' && current.phase === 'waiting') {
      if (event.deckId != null && event.deckId !== current.deckId) {
        current.incomplete = true
        current.phase = 'interrupted'
      } else current.phase = 'ready'
      return true
    }
    if (type === 'retreat') {
      const ids = new Set(event.ids ?? [])
      const slots = event.slots ?? []
      for (const ship of current.ships) {
        if (ids.has(ship.id) || slots.some(slot => slot.group === ship.group && slot.slot === ship.slot)) ship.retreated = true
      }
      return true
    }
    if (type !== 'result' || current.phase !== 'ready') return false
    current.phase = 'settled'
    current.battles += 1
    const hasEscort = current.ships.some(ship => ship.group === 'escort')
    if (!hasEscort && !current.expectsEscort && Array.isArray(event.escort) && event.escort.some(value => value > 0)) {
      current.incomplete = true
      return true
    }
    for (const [group, raw] of [['main', event.main], ['escort', event.escort]]) {
      const values = decodeRewards(current.ships, group, raw)
      if (values) reward(current, values)
      else current.incomplete = true
    }
    return true
  }

  update()
  return {
    handle(event) {
      if (!event || typeof event.type !== 'string') return
      const changed = accept(event)
      const retrying = dirty
      persist()
      if (changed || retrying) update()
    },
    setTracking(enabled) {
      if (!accountId || readFailed) return
      archive = { ...archive, tracking: Boolean(enabled) }
      dirty = true
      persist()
      update()
    },
    clearTotal() {
      if (!accountId || readFailed) return
      current?.pendingTotals.clear()
      archive = { ...archive, totalSorties: 0, totals: [] }
      dirty = true
      persist()
      update()
    },
    getSnapshot: () => view,
  }
}

module.exports = { createExperience }
