'use strict'

const { poiPlugin } = require('../package.json')
const number = new Intl.NumberFormat('zh-CN')
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
const noShips = Object.freeze({})
const noGameSnapshot = () => noShips
const noGameSubscription = () => () => {}
const knownExp = value => Number.isSafeInteger(value) && value >= 0
const positive = value => Number.isSafeInteger(value) && value > 0
const shipsPerPage = 10
const resourceLabels = {
  fuel: '燃料', ammo: '弹药', steel: '钢材', bauxite: '铝土', buckets: '桶',
}
const resourceKinds = Object.keys(resourceLabels)
const supplyKinds = ['fuel', 'ammo', 'bauxite']
const repairKinds = ['fuel', 'steel', 'buckets']
const resourceWarning = '部分明细未捕获，仅显示已确认支出。'
const amountFor = (amounts, kind) => knownExp(amounts?.[kind]) ? amounts[kind] : 0
const hasSpending = amounts => resourceKinds.some(kind => positive(amountFor(amounts, kind)))

function closeOnBackdrop(event) {
  const dialog = event.currentTarget
  if (event.target !== dialog) return
  const { left, top, right, bottom } = dialog.getBoundingClientRect()
  if (event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom) dialog.close()
}

function matchingGameShip(ship, gameShips) {
  const candidate = gameShips[ship.id]
  return candidate && (!positive(ship.masterId) || ship.masterId === candidate.masterId) ? candidate : undefined
}

function displayName(ship, live, t) {
  return t(`resources:${live?.name ?? ship.name}`, { keySeparator: 'chiba' })
}

function sumExperience(ships) {
  return ships.length ? ships.reduce((sum, ship) => knownExp(ship.exp) ? (sum ?? 0) + ship.exp : sum, null) : 0
}

function createPanel(React, tracker, subscribe, css, {
  ShipAvatar, Gradient, ShipBasic, ShipName, ShipSubText, ShipLabel, useTranslation,
  subscribeGame = noGameSubscription, getGameSnapshot = noGameSnapshot,
  resourceIcons = noShips,
}) {
  const h = React.createElement
  const button = (label, onClick, options = {}) => h('button', { type: 'button', onClick, ...options }, label)
  const expText = value => knownExp(value) ? `${value > 0 ? '+' : ''}${number.format(value)}` : '未捕获'
  const summaryExp = value => knownExp(value) ? [expText(value), h('small', { key: 'unit' }, ' EXP')] : '—'

  function ResourceIcon({ kind }) {
    const src = resourceIcons[kind]
    return src ? h('img', { className: 'pex-resource-icon', src, alt: '', draggable: false }) : null
  }

  function ResourceAmounts({ amounts, kinds = resourceKinds, summary = false }) {
    const recorded = hasSpending(amounts)
    if (!recorded && !summary) return h('span', { className: 'pex-muted' }, '未统计')
    if (summary) {
      const values = kinds.map(kind => recorded ? number.format(amountFor(amounts, kind)) : '—')
      const longest = Math.max(...values.map(value => value.length))
      return h('dl', { className: 'pex-resource-grid', style: { '--resource-value-length': longest } },
        kinds.map((kind, index) => h('div', { key: kind },
        h('dt', null, h(ResourceIcon, { kind }), resourceLabels[kind]),
        h('dd', null, values[index]))))
    }
    return h('span', { className: 'pex-resource-amounts' }, kinds.map(kind => {
      const value = number.format(amountFor(amounts, kind))
      const label = `${resourceLabels[kind]} ${value}`
      return h('span', { key: kind, className: 'pex-resource-amount', title: label, 'aria-label': label },
        h(ResourceIcon, { kind }), resourceIcons[kind] ? null : `${resourceLabels[kind]} `, value)
    }))
  }

  function amountsText(amounts, kinds, showZero = false) {
    return showZero || hasSpending(amounts)
      ? kinds.map(kind => `${resourceLabels[kind]} ${number.format(amountFor(amounts, kind))}`).join(' · ')
      : '未统计'
  }

  function ExperienceValue({ exp, sum }) {
    const recorded = knownExp(exp)
    return h('span', { className: `pex-exp${recorded ? '' : ' pex-missing'}` }, expText(exp),
      recorded ? h('span', { className: 'pex-share' }, percent.format(sum ? exp / sum : 0)) : null)
  }

  function MvpValue({ count }) {
    return h('span', { className: `pex-mvp${positive(count) ? ' pex-mvp-earned' : ''}` },
      knownExp(count) ? number.format(count) : '—')
  }

  function ShipTile({ ship, live, name, t }) {
    const masterId = live?.masterId ?? ship.masterId
    const isDamaged = Boolean(live?.isDamaged ?? ship.isDamaged)
    const level = live?.level ?? ship.level
    const kind = live?.kind ?? ship.kind
    const nextExp = live?.nextExp ?? ship.nextExp
    const [failed, setFailed] = React.useState(null)
    const artKey = `${masterId}:${isDamaged}`
    return h('div', {
      className: 'bp6-card pex-ship-tile',
      onErrorCapture: () => setFailed(artKey),
      onLoadCapture: () => setFailed(null),
    },
    positive(masterId) ? h(ShipAvatar, {
      className: `pex-native-avatar${failed === artKey ? ' pex-avatar-unavailable' : ''}`,
      mstId: masterId, isDamaged, height: 58, useFixedWidth: false, useDefaultBG: false,
    }) : null,
    h(Gradient, { color: live?.avatarColor ?? ship.avatarColor }),
    h(ShipBasic, { avatar: true, className: 'ship-basic' },
      h('span', { className: 'ship-lv' }, 'Lv. ', positive(level) ? level : '??'),
      h(ShipLabel, { className: 'ship-type' }, kind ? t(`resources:${kind}`) : '??')),
    h(ShipName, { avatar: true, className: 'ship-name', title: name }, name),
    h(ShipSubText, { avatar: true, className: 'ship-exp' }, 'Next. ', knownExp(nextExp) ? nextExp : '—'))
  }

  function ShipTable({ ships, fleet, total, sum, gameShips, battleCount, resources, onBill }) {
    const { t } = useTranslation(['main', 'resources'])
    const spending = Boolean(resources)
    return h('table', {
      className: `pex-table${spending ? ' pex-spending-table' : ''}`,
      'aria-label': spending ? '逐舰资源支出' : '逐舰获得经验',
    },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, '舰娘'),
        h('th', { scope: 'col' }, spending ? '本轮消耗' : total ? '总累计经验' : '获得经验'),
        spending ? null : h('th', { scope: 'col', title: total ? '本轮累计的 MVP 次数' : '这趟出击的 MVP 次数' }, 'MVP'))),
      h('tbody', null, ships.flatMap((ship, index) => {
        const live = matchingGameShip(ship, gameShips)
        const name = displayName(ship, live, t)
        const shipSpending = resources?.byShip?.[ship.id]
        const openBill = onBill ? () => onBill(ship.id, name) : undefined
        const amounts = h(React.Fragment, null, h(ResourceAmounts, { amounts: shipSpending?.total }),
          shipSpending?.incomplete ? h('span', { className: 'pex-resource-info', title: resourceWarning, 'aria-label': resourceWarning }, 'ⓘ') : null)
        const row = h('tr', { key: ship.id, 'data-ship': ship.id, onClick: openBill },
          h('td', null, h(ShipTile, { ship, live, name, t }),
            ship.retreated ? h('div', { className: 'pex-ship-retreated' }, '已退避') : null),
          spending
            ? h('td', null, onBill ? button(amounts, undefined,
              { className: 'pex-bill-trigger', 'aria-label': `查看 ${name} 的账单` }) : amounts)
            : h('td', null, h(ExperienceValue, { exp: ship.exp, sum })),
          spending ? null : h('td', null, h(MvpValue, { count: battleCount === 0 ? 0 : ship.mvpCount })))
        if (fleet && (index === 0 || ship.group !== ships[index - 1].group)) {
          return [h('tr', { key: `fleet-${ship.id}`, className: 'pex-fleet' },
            h('th', { colSpan: spending ? 2 : 3 }, ship.group === 'main' ? '主力舰队' : '护卫舰队')), row]
        }
        return [row]
      })))
  }

  function PaginatedShipTable({ ships, ...tableProps }) {
    const [pageIndex, setPageIndex] = React.useState(0)
    const pageCount = Math.ceil(ships.length / shipsPerPage)
    const page = Math.min(pageIndex, pageCount - 1)
    const first = page * shipsPerPage
    React.useEffect(() => {
      setPageIndex(index => Math.min(index, pageCount - 1))
    }, [pageCount])
    return h(React.Fragment, null,
      h(ShipTable, { ...tableProps, ships: ships.slice(first, first + shipsPerPage), total: true }),
      pageCount > 1 ? h('nav', { className: 'pex-pagination', 'aria-label': '总累计舰娘分页' },
        button('上一页', () => setPageIndex(page - 1), { className: 'pex-button', disabled: page === 0 }),
        h('span', { className: 'pex-muted', 'aria-live': 'polite' }, `第 ${page + 1} / ${pageCount} 页`),
        button('下一页', () => setPageIndex(page + 1), { className: 'pex-button', disabled: page === pageCount - 1 }))
        : null)
  }

  function metric(label, value, unit, experience = false) {
    return h('div', { className: `pex-metric${experience ? ' pex-metric-exp' : ''}` },
      h('div', { className: 'pex-muted' }, label),
      h('strong', { className: 'pex-metric-value' }, value, unit ? h('small', null, unit) : null))
  }

  function details(ships, { total = false, totalCount = ships.length, customize, resourceSort, pageKey, ...tableProps }) {
    const count = ships.length === totalCount ? `${number.format(totalCount)} 艘舰船`
      : `显示 ${number.format(ships.length)} / ${number.format(totalCount)} 艘`
    const empty = totalCount ? '当前未显示任何舰娘' : total ? '暂无累计经验' : '暂无舰船记录'
    const table = total ? h(PaginatedShipTable, { ...tableProps, key: pageKey, ships })
      : h(ShipTable, { ...tableProps, ships, fleet: ships.some(ship => ship.group === 'escort') })
    return h('section', { className: 'pex-card' },
      h('header', { className: 'pex-card-heading' }, h('h3', null, total ? '逐舰总累计' : '舰队明细'),
        h('div', { className: 'pex-card-controls' }, h('span', { className: 'pex-muted' }, count),
          customize ? h('div', { className: 'pex-card-actions' }, customize, resourceSort) : null)),
      ships.length ? table : h('div', { className: 'pex-empty' }, h('strong', null, empty)))
  }

  function runView(view, gameShips) {
    const run = view.current ?? view.last
    if (!run) return h('div', { className: 'pex-card pex-empty' },
      h('strong', null, view.accountReady ? '暂无出击记录' : '等待游戏账号'),
      h('span', null, view.accountReady ? '普通出击或演习结算后，这里会显示逐舰经验。' : '登录游戏并进入母港即可开始记录。'))
    const live = Boolean(view.current)
    const practice = run.kind === 'practice'
    const status = practice ? (live ? '演习中' : '演习已结算') : (live ? '出击中' : '已返港')
    const sum = sumExperience(run.ships)
    return h('div', null,
      h('div', { className: 'pex-card pex-context', 'aria-live': 'polite' },
        metric(practice ? '出击类型' : '海域', practice ? '演习' : run.map),
        metric('出击舰队', `第 ${run.deckId} 舰队`),
        metric('已结算', number.format(run.battles), ' 场战斗'),
        metric(practice ? (live ? '本次演习合计' : '上次演习合计') : (live ? '本次舰队合计' : '上次舰队合计'),
          summaryExp(sum), null, true),
        h('span', { className: 'pex-status' }, status)),
      run.incomplete ? h('p', { className: 'pex-warning' }, '数据不完整，仅显示已确认经验。') : null,
      details(run.ships, { sum, gameShips, battleCount: run.battles }))
  }

  function ClearTotalButton({ accountId, disabled }) {
    const dialog = React.useRef(null)
    const titleId = React.useId()
    const descriptionId = React.useId()
    const close = () => dialog.current.close()
    const confirm = () => {
      close()
      if (tracker.getSnapshot().accountId === accountId) tracker.clearTotal()
    }

    return h(React.Fragment, null,
      button('清零', () => dialog.current.showModal(), {
        className: 'pex-button pex-clear-button', 'aria-haspopup': 'dialog', disabled,
      }),
      h('dialog', {
        ref: dialog, className: 'pex-clear-dialog', 'aria-labelledby': titleId, 'aria-describedby': descriptionId,
      },
      h('h3', { id: titleId }, '是否清零总累计记录？'),
      h('p', { id: descriptionId }, '将清除当前账号的累计出击场数、经验、MVP 和资源支出。'),
      h('div', { className: 'pex-clear-actions' },
        button('取消', close, { className: 'pex-button' }),
        button('确认', confirm, { className: 'pex-button pex-clear-confirm' }))))
  }

  function TotalShipFilter({ view, sum, gameShips }) {
    const { t } = useTranslation(['main', 'resources'])
    const dialog = React.useRef(null)
    const titleId = React.useId()
    const [query, setQuery] = React.useState('')
    const [isOpen, setIsOpen] = React.useState(false)
    const [draft, setDraft] = React.useState(null)
    const ships = view.totals
    const selected = new Set(draft ?? ships.map(ship => ship.id))
    const shown = ships.filter(ship => selected.has(ship.id)).length
    const search = query.trim().toLocaleLowerCase()
    const matches = search ? ships.filter(ship => {
      const live = matchingGameShip(ship, gameShips)
      return displayName(ship, live, t).toLocaleLowerCase().includes(search)
    }) : ships
    const toggle = (id, checked) => {
      setDraft(previous => {
        const next = new Set(previous ?? ships.map(ship => ship.id))
        if (checked) next.add(id)
        else next.delete(id)
        return ships.every(ship => next.has(ship.id)) ? null : [...next]
      })
    }
    const open = () => {
      setQuery('')
      setDraft(view.totalShipSelection)
      dialog.current.showModal()
      setIsOpen(true)
    }
    const close = () => dialog.current.close()
    const confirm = () => {
      const current = tracker.getSnapshot()
      if (current.accountId === view.accountId && draft !== current.totalShipSelection) {
        const available = new Set(current.totals.map(ship => ship.id))
        tracker.setTotalShipSelection(draft?.filter(id => available.has(id)) ?? null)
      }
      close()
    }

    return h(React.Fragment, null,
      button('自定义显示', open, { className: 'pex-button', 'aria-haspopup': 'dialog', disabled: !view.accountReady || !ships.length }),
      h('dialog', {
        ref: dialog, className: 'pex-filter-dialog', 'aria-labelledby': titleId,
        onClose: event => setIsOpen(event.currentTarget.open),
        onClick: closeOnBackdrop,
      },
        h('header', { className: 'pex-dialog-heading' },
          h('h3', { id: titleId }, '自定义显示舰娘'),
          button('×', close, { className: 'pex-dialog-close', 'aria-label': '关闭' })),
        h('input', {
          className: 'pex-filter-search', type: 'search', value: query, placeholder: '搜索舰娘',
          'aria-label': '搜索舰娘', onChange: event => setQuery(event.target.value),
        }),
        h('div', { className: 'pex-filter-tools' },
          h('span', { className: 'pex-muted', 'aria-live': 'polite' }, `已选 ${shown} / ${ships.length} 艘`),
          button('显示全部', () => setDraft(null), { className: 'pex-button' }),
          button('全部隐藏', () => setDraft([]), { className: 'pex-button', disabled: !ships.length })),
        isOpen ? h('ul', { className: 'pex-filter-list', 'aria-label': '已统计舰娘' }, matches.length ? matches.map(ship => {
          const live = matchingGameShip(ship, gameShips)
          const name = displayName(ship, live, t)
          return h('li', { key: ship.id }, h('label', { className: 'pex-filter-row' },
            h('input', { type: 'checkbox', checked: selected.has(ship.id), 'aria-label': `显示 ${name}`,
              onChange: event => toggle(ship.id, event.target.checked) }),
            h(ShipTile, { ship, live, name, t }),
            h(ExperienceValue, { exp: ship.exp, sum }),
            h(MvpValue, { count: ship.mvpCount })))
        }) : h('li', { className: 'pex-filter-empty' }, ships.length ? '没有匹配的舰娘' : '暂无已统计的舰娘')) : null,
        h('div', { className: 'pex-clear-actions' },
          button('取消', close, { className: 'pex-button' }),
          button('完成', confirm, { className: 'pex-button pex-filter-done' }))))
  }

  function WarehouseSummary({ resources }) {
    const positiveKinds = amounts => resourceKinds.filter(kind => amountFor(amounts, kind) > 0)
    return h('section', { className: 'pex-card pex-warehouse-summary' },
      h('h3', null, '本轮仓库支出'),
      h(ResourceAmounts, { amounts: resources.confirmed, summary: true }),
      hasSpending(resources.confirmed) ? null : h('p', { className: 'pex-muted' }, '未统计'),
      hasSpending(resources.pending) ? h('p', { className: 'pex-muted' },
        `本轮待补给 · ${amountsText(resources.pending, positiveKinds(resources.pending))}`) : null,
      hasSpending(resources.unallocated) ? h('p', { className: 'pex-muted' },
        `补给差额，待核对 · ${amountsText(resources.unallocated, positiveKinds(resources.unallocated))}`) : null,
      resources.incomplete ? h('p', { className: 'pex-resource-info' }, resourceWarning) : null)
  }

  function ResourceSort({ selected, onSelect }) {
    const anchor = React.useRef(null)
    const trigger = React.useRef(null)
    const menu = React.useRef(null)
    const id = React.useId()
    const [open, setOpen] = React.useState(false)

    React.useEffect(() => {
      if (!open) return undefined
      const doc = anchor.current.ownerDocument
      const closeOutside = event => {
        if (!anchor.current?.contains(event.target)) setOpen(false)
      }
      doc.addEventListener('pointerdown', closeOutside, true)
      const initial = menu.current.querySelector('[aria-checked="true"]') ?? menu.current.firstElementChild
      initial?.focus()
      return () => doc.removeEventListener('pointerdown', closeOutside, true)
    }, [open])

    const close = () => {
      trigger.current.focus()
      setOpen(false)
    }
    const handleKey = event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End']
      if (!keys.includes(event.key)) return
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const options = Array.from(menu.current.children)
      const active = options.indexOf(event.target)
      let next = 0
      if (event.key === 'End') next = options.length - 1
      if (event.key === 'ArrowUp') next = (active + options.length - 1) % options.length
      if (event.key === 'ArrowDown') next = (active + 1) % options.length
      options[next].focus()
    }

    return h('div', { className: 'pex-sort', ref: anchor, onKeyDown: handleKey,
      onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) } },
    button([selected ? resourceLabels[selected] : '资源排序', h('span', { key: 'chevron', 'aria-hidden': true }, '▾')],
      () => setOpen(!open), { ref: trigger, className: 'pex-button pex-sort-trigger', 'aria-label': '资源排序',
        'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': open ? id : undefined }),
    open ? h('div', { id, ref: menu, role: 'menu', 'aria-label': '资源排序', className: 'pex-sort-menu' },
      resourceKinds.map(kind => button([
        h(ResourceIcon, { key: 'icon', kind }), resourceLabels[kind],
        selected === kind ? h('span', { key: 'check', className: 'pex-sort-check', 'aria-hidden': true }, '✓') : null,
      ], () => { onSelect(kind); close() }, { key: kind, role: 'menuitemradio', 'aria-checked': selected === kind, tabIndex: -1 }))) : null)
  }

  function ShipBill({ bill, resources, clearBill }) {
    const dialog = React.useRef(null)
    const titleId = React.useId()
    const id = bill?.id
    React.useEffect(() => {
      if (bill && !dialog.current.open) dialog.current.showModal()
    }, [bill])
    const spending = resources.byShip?.[id]
    const close = () => dialog.current.close()
    return h('dialog', { ref: dialog, className: 'pex-bill-dialog', 'aria-labelledby': titleId,
      onClick: closeOnBackdrop, onClose: () => { if (!dialog.current?.open) clearBill() } }, bill ? h(React.Fragment, null,
      h('header', { className: 'pex-dialog-heading' },
        h('h3', { id: titleId }, `${bill.name} 的账单`),
        button('×', close, { className: 'pex-dialog-close', 'aria-label': '关闭账单' })),
      h('dl', { className: 'pex-bill-items' },
        h('dt', null, '出击补给支出'), h('dd', null, amountsText(spending?.supply, supplyKinds)),
        h('dt', null, '入渠与加速'), h('dd', null, amountsText(spending?.repair, repairKinds)),
        h('dt', null, '本轮待补给'), h('dd', null, amountsText(spending?.pending, supplyKinds, hasSpending(spending?.total)))),
      spending?.incomplete ? h('p', { className: 'pex-resource-info' }, resourceWarning) : null,
      h('div', { className: 'pex-clear-actions' }, button('关闭', close, { className: 'pex-button' }))) : null)
  }

  function TotalView({ view, gameShips }) {
    const [mode, setMode] = React.useState('experience')
    const [sort, setSort] = React.useState(null)
    const [bill, setBill] = React.useState(null)
    const disabled = !view.accountReady
    const spending = mode === 'spending'
    const resources = view.resources ?? noShips
    const sum = sumExperience(view.totals)
    const selection = view.totalShipSelection === null ? null : new Set(view.totalShipSelection)
    const ships = selection === null ? view.totals : view.totals.filter(ship => selection.has(ship.id))
    const sorted = spending && sort ? [...ships].sort((a, b) => {
      const aAmount = amountFor(resources.byShip?.[a.id]?.total, sort)
      const bAmount = amountFor(resources.byShip?.[b.id]?.total, sort)
      return bAmount - aAmount || (b.exp ?? -1) - (a.exp ?? -1) || a.id - b.id
    }) : ships
    return h('div', null,
      h('div', { className: 'pex-card pex-context pex-context-total' },
        metric('累计记录', `总累计 ${number.format(view.totalSorties)} 场`, ' 出击'),
        metric('全部舰船合计', summaryExp(sum), null, true),
        h('div', { className: 'pex-total-controls' },
          button(view.tracking ? '累计开启' : '累计关闭', () => tracker.setTracking(!view.tracking), {
            className: 'pex-switch', role: 'switch', 'aria-label': '累计开关', 'aria-checked': view.tracking, disabled,
          }),
          h(ClearTotalButton, { key: view.accountId, accountId: view.accountId, disabled }))),
      h('div', { className: 'pex-tabs pex-subtabs', 'aria-label': '总累计内容' },
        button('经验', () => setMode('experience'), { 'aria-pressed': !spending }),
        button('消耗', () => setMode('spending'), { 'aria-pressed': spending })),
      spending ? h(WarehouseSummary, { resources }) : null,
      details(sorted, {
        total: true, sum, gameShips, totalCount: view.totals.length,
        pageKey: `${mode}:${sort}:${JSON.stringify(view.totalShipSelection)}`,
        resources: spending ? resources : undefined,
        onBill: spending && !disabled ? (id, name) => setBill({ id, name }) : undefined,
        customize: h(TotalShipFilter, { view, sum, gameShips }),
        resourceSort: spending && ships.length ? h(ResourceSort, { selected: sort, onSelect: setSort }) : null,
      }),
      spending ? h(ShipBill, { bill, resources, clearBill: () => setBill(null) }) : null)
  }

  return function ExperiencePanel() {
    const view = React.useSyncExternalStore(subscribe, tracker.getSnapshot, tracker.getSnapshot)
    const gameShips = React.useSyncExternalStore(subscribeGame, getGameSnapshot, getGameSnapshot) ?? noShips
    const [tab, setTab] = React.useState('run')
    return h('section', { className: 'pex', 'aria-label': poiPlugin.name },
      h('style', null, css),
      h('header', { className: 'pex-header' },
        h('div', { className: 'pex-kicker' }, 'SORTIE EXPERIENCE'), h('h2', null, poiPlugin.name)),
      h('div', { className: 'pex-tabs', 'aria-label': '经验统计视图' },
        button(view.current ? '本次出击' : '上次出击', () => setTab('run'), { 'aria-pressed': tab === 'run' }),
        button('总累计', () => setTab('total'), { 'aria-pressed': tab === 'total' })),
      h('div', { className: 'pex-content', 'data-tone': tab === 'run' && view.current ? 'live' : 'done' },
        view.storageError ? h('p', { className: 'pex-warning', role: 'status' }, '本地统计暂时无法读取或保存。') : null,
        tab === 'run' ? runView(view, gameShips) : h(TotalView, { key: view.accountId, view, gameShips })))
  }
}

module.exports = { createPanel }
