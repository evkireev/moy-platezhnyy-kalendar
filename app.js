'use strict';

// 1. Pure domain functions: no DOM, storage or timers.
const CalendarCore = (() => {
  const KEY = 'paymentCalendar.v1';
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const clone = x => JSON.parse(JSON.stringify(x));
  const fail = (message, field) => { const e = new Error(message); e.field = field; throw e; };
  const safe = n => { if (!Number.isSafeInteger(n)) fail('Сумма превышает допустимую точность.'); return n; };
  const add = (a, b) => safe(a + b);
  const sum = a => a.reduce(add, 0);
  function money(text, signed = false) {
    const s = String(text).trim().replace(/[\s\u00a0\u202f]/g, '');
    if (!(signed ? /^-?\d+(?:[.,]\d{1,2})?$/ : /^\d+(?:[.,]\d{1,2})?$/).test(s)) fail('Введите сумму цифрами, не более двух знаков после запятой.', 'amount');
    const negative = s.startsWith('-');
    const [a, b = ''] = s.replace('-', '').split(/[.,]/);
    const n = BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('Сумма слишком велика.', 'amount');
    if (!signed && n === 0n) fail('Сумма должна быть больше нуля.', 'amount');
    return Number(n) * (negative ? -1 : 1);
  }
  function formatMoney(n, compact = false) {
    safe(n); const abs = BigInt(n < 0 ? -n : n);
    const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    const cents = (abs % 100n).toString().padStart(2, '0');
    return (n < 0 ? '−' : '') + whole + (compact && cents === '00' ? '' : ',' + cents) + '\u00a0₽';
  }
  const moneyInput = n => { const s = BigInt(n).toString(); const a = s.replace('-', '').padStart(3, '0'); return (n < 0 ? '-' : '') + a.slice(0, -2) + ',' + a.slice(-2); };
  const validMonth = m => typeof m === 'string' && /^(19\d{2}|20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(m);
  const monthIndex = m => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
  const fromIndex = n => String(Math.floor(n / 12)).padStart(4, '0') + '-' + String(n % 12 + 1).padStart(2, '0');
  const shiftMonth = (m, n) => fromIndex(monthIndex(m) + n);
  const days = m => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && validMonth(d.slice(0, 7)) && Number(d.slice(8)) >= 1 && Number(d.slice(8)) <= days(d.slice(0, 7));
  function today(zone, now = new Date()) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    return ['year', 'month', 'day'].map(t => p.find(x => x.type === t).value).join('-');
  }
  const normalize = s => s.normalize('NFC').trim().toLocaleLowerCase('ru');
  const named = s => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= 120;
  function blank(firstMonth, opening = 0) {
    return { settings: { timeZone: 'Asia/Yekaterinburg', currency: 'RUB', firstMonth, incomeSortMode: 'amount', expenseSortMode: 'amount', ungroupedExpenseOrder: 1, hidePastDays: false, collapsedGroupIds: [] }, openingBalances: { [firstMonth]: opening }, groups: [], rows: [], operations: [], series: [], exceptions: [] };
  }
  function validateData(d) {
    if (!d || !d.settings || !d.openingBalances || Array.isArray(d.openingBalances)) fail('Повреждена структура данных.');
    for (const k of ['groups', 'rows', 'operations', 'series', 'exceptions']) if (!Array.isArray(d[k])) fail('Отсутствует коллекция: ' + k);
    const s = d.settings;
    if(s.hidePastDays!==undefined && typeof s.hidePastDays!=='boolean') fail('Некорректная настройка скрытия дней.');
    if(s.topbarCollapsed!==undefined && typeof s.topbarCollapsed!=='boolean') fail('Некорректная настройка верхней панели.');
    if(s.collapsedGroupIds!==undefined && (!Array.isArray(s.collapsedGroupIds)||s.collapsedGroupIds.some(id=>typeof id!=='string'||!d.groups.some(g=>g.id===id))||new Set(s.collapsedGroupIds).size!==s.collapsedGroupIds.length)) fail('Некорректная настройка сворачивания групп.');
    if (!validMonth(s.firstMonth) || !own(d.openingBalances, s.firstMonth)) fail('Не задан начальный месяц или остаток.');
    if (s.currency !== 'RUB' || !['amount', 'manual'].includes(s.incomeSortMode) || !['amount', 'manual'].includes(s.expenseSortMode)) fail('Некорректные настройки.');
    if(typeof s.timeZone!=='string'||!s.timeZone.trim()) fail('Укажите часовой пояс.', 'timeZone');
    try { today(s.timeZone); } catch { fail('Неизвестный часовой пояс.', 'timeZone'); }
    const positive = n => Number.isSafeInteger(n) && n > 0;
    if (!positive(s.ungroupedExpenseOrder)) fail('Неверный порядок групп.');
    for (const [m, v] of Object.entries(d.openingBalances)) { if (!validMonth(m) || m < s.firstMonth) fail('Неверный месяц остатка.'); safe(v); }
    const ids = new Set();
    const checkId = x => { if (typeof x.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x.id) || ids.has(x.id)) fail('Некорректный или повторный идентификатор.'); ids.add(x.id); };
    const groupNames = new Set(); const groupIds = new Set(); const orders = new Set(['group:' + s.ungroupedExpenseOrder]);
    for (const g of d.groups) { checkId(g); if (!named(g.name) || groupNames.has(normalize(g.name))) fail('Название группы уже существует или некорректно.', 'name'); groupNames.add(normalize(g.name)); groupIds.add(g.id); if (!positive(g.order) || orders.has('group:' + g.order)) fail('Неверный порядок групп.'); orders.add('group:' + g.order); }
    const rowNames = new Set(); const rowIds = new Set();
    for (const r of d.rows) {
      checkId(r); if (!['income', 'expense'].includes(r.type) || typeof r.archived !== 'boolean') fail('Неверные параметры строки.');
      const nk = r.type + ':' + normalize(String(r.name));
      if (!named(r.name) || rowNames.has(nk)) fail('Такое название уже есть, в том числе в архиве. Восстановите архивную строку или выберите другое имя.', 'name');
      rowNames.add(nk); rowIds.add(r.id);
      if (r.groupId !== null && (!groupIds.has(r.groupId) || r.type === 'income')) fail('Не найдена группа строки.');
      const ok = r.type + ':' + r.groupId + ':' + r.order;
      if (!positive(r.order) || orders.has(ok)) fail('Некорректный порядок строк.'); orders.add(ok);
    }
    const seriesIds = new Set();
    for (const series of d.series) {
      if(!series || typeof series.id!=='string')fail('Некорректный идентификатор повторения.');checkId(series); seriesIds.add(series.id);
      if (!Array.isArray(series.versions) || !series.versions.length) fail('Нет версий повторения.');
      let previous = '';
      for (const v of series.versions) {
        if (!validMonth(v.effectiveFrom) || v.effectiveFrom <= previous || !validMonth(v.firstMonth) || v.firstMonth < s.firstMonth || v.effectiveFrom < v.firstMonth || (v.lastMonth !== null && (!validMonth(v.lastMonth) || v.lastMonth < v.firstMonth))) fail('Некорректные границы версии повторения.');
        previous = v.effectiveFrom;
        if (!rowIds.has(v.rowId) || !positive(v.amountMinor) || !Number.isInteger(v.dayOfMonth) || v.dayOfMonth < 1 || v.dayOfMonth > 31 || typeof v.shiftWeekend !== 'boolean' || typeof v.title !== 'string' || v.title.length > 200 || typeof v.comment !== 'string' || v.comment.length > 2000) fail('Некорректные параметры повторения.');
      }
    }
    const keys = new Set();
    for (const e of d.exceptions) {
      if (!seriesIds.has(e.seriesId) || !validMonth(e.sourceMonth) || e.sourceMonth < s.firstMonth || e.occurrenceKey !== e.seriesId + ':' + e.sourceMonth || keys.has(e.occurrenceKey) || typeof e.deleted !== 'boolean' || (e.deleted ? e.operation !== null : !e.operation)) fail('Некорректное исключение повторения.');
      keys.add(e.occurrenceKey);
      if(e.sourceMonth<d.series.find(s=>s.id===e.seriesId).versions[0].firstMonth)fail('Исключение раньше начала серии.');
    }
    for (const o of storedOperations(d)) {
      checkId(o); if (!rowIds.has(o.rowId)) fail('Не найдена строка операции.', 'rowId');
      if (!positive(o.amountMinor)) fail('Сумма должна быть положительной.', 'amount');
      if (!validDate(o.plannedDate) || o.plannedDate.slice(0, 7) < s.firstMonth) fail('Дата должна быть не раньше первого месяца учёта.', 'plannedDate');
      if (typeof o.title !== 'string' || o.title.length > 200 || typeof o.comment !== 'string' || o.comment.length > 2000) fail('Слишком длинное назначение или комментарий.');
      if (!Number.isSafeInteger(o.cancelledMinor) || o.cancelledMinor < 0 || !Array.isArray(o.settlements)) fail('Неверные части операции.');
      for (const p of o.settlements) { checkId(p); if (!positive(p.amountMinor) || !validDate(p.actualDate) || p.actualDate.slice(0,7)<s.firstMonth || typeof p.createdAt!=='string') fail('Неверная исполненная часть.'); }
      if (add(sum(o.settlements.map(p => p.amountMinor)), o.cancelledMinor) > o.amountMinor) fail('Исполнено больше общей суммы.');
    }
    // Verify even distant projections before writing, not merely the currently visible month.
    const cache = new Map(); let bound = s.firstMonth;
    for (const o of storedOperations(d)) for(const date of [o.plannedDate,...o.settlements.map(p=>p.actualDate)]) if (date.slice(0, 7) > bound) bound = date.slice(0, 7);
    if (d.series.length) bound = '2100-12';
    for (const m of Object.keys(d.openingBalances)) if (m > bound) bound = m;
    for (let i = monthIndex(s.firstMonth); i <= monthIndex(bound); i++) { const m = fromIndex(i); const f = flows(d, m); let b = opening(d, m, cache); for (let j = 0; j < days(m); j++) b = add(add(b, f.income[j]), -f.expense[j]); cache.set(m, b); }
    return d;
  }
  function validateRoot(r) {
    if (!r || r.schemaVersion !== 1 || !Number.isSafeInteger(r.revision) || r.revision < 1 || !r.auth) fail('Неизвестный или повреждённый формат хранилища.');
    const a = r.auth;
    if (typeof a.displayName !== 'string' || !a.displayName.trim() || a.displayName.length > 80 || a.passwordAlgorithm !== 'PBKDF2-SHA-256' || a.iterations !== 600000 || typeof a.saltBase64 !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(a.saltBase64) || typeof a.verifierBase64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(a.verifierBase64)) fail('Повреждены параметры локального профиля.');
    validateData(r.data);
    if (!r.localMeta) r.localMeta = {};
    if(!own(r.localMeta,'lastExportRequestedAt'))r.localMeta.lastExportRequestedAt=null;
    if(!own(r.localMeta,'changesSinceExport'))r.localMeta.changesSinceExport=0;
    if(r.localMeta.lastExportRequestedAt!==null&&!isoTime(r.localMeta.lastExportRequestedAt))fail('Повреждена дата экспорта.');
    if (!Number.isSafeInteger(r.localMeta.changesSinceExport) || r.localMeta.changesSinceExport < 0) fail('Повреждены служебные настройки.');
    return r;
  }
  const paid = o => sum(o.settlements.map(p=>p.amountMinor));
  const isoTime = s => typeof s==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s) && validDate(s.slice(0,10)) && Number.isFinite(Date.parse(s));
  function cleanData(input){
    const pick=(o,keys)=>{if(!o||typeof o!=='object'||Array.isArray(o))fail('Неверная структура резервной копии.');const result={};for(const k of keys.split(' '))if(own(o,k))result[k]=o[k];return result;};
    const list=(a,fn)=>{if(!Array.isArray(a))fail('В копии отсутствует обязательная коллекция.');return a.map(fn);};
    const operation=o=>{const x=pick(o,'id rowId amountMinor plannedDate title comment cancelledMinor createdAt updatedAt');if(!isoTime(x.createdAt)||!isoTime(x.updatedAt))fail('Некорректная дата создания или изменения операции.');x.settlements=list(o.settlements,p=>{const s=pick(p,'id amountMinor actualDate createdAt');if(!isoTime(s.createdAt))fail('Некорректная дата исполнения.');return s;});return x;};
    const d=pick(input,'');d.settings=pick(input.settings,'timeZone currency firstMonth incomeSortMode expenseSortMode ungroupedExpenseOrder hidePastDays collapsedGroupIds topbarCollapsed');
    if(!input.openingBalances||typeof input.openingBalances!=='object'||Array.isArray(input.openingBalances))fail('Нет начальных остатков.');
    d.openingBalances={};for(const [m,v] of Object.entries(input.openingBalances)){if(!validMonth(m))fail('Некорректный месяц остатка.');d.openingBalances[m]=v;}
    d.groups=list(input.groups,g=>pick(g,'id name order'));d.rows=list(input.rows,r=>pick(r,'id type name groupId order archived'));
    d.operations=list(input.operations,operation);
    d.series=list(input.series,s=>({...pick(s,'id'),versions:list(s.versions,v=>pick(v,'effectiveFrom firstMonth lastMonth rowId amountMinor dayOfMonth shiftWeekend title comment'))}));
    d.exceptions=list(input.exceptions,e=>({...pick(e,'occurrenceKey seriesId sourceMonth deleted'),operation:e.operation===null?null:operation(e.operation)}));
    try{return validateData(d);}catch(e){fail(e instanceof TypeError?'Некорректные типы полей резервной копии.':e.message);}
  }
  function readBackup(text){
    if(new TextEncoder().encode(text).length>10*1024*1024)fail('Файл больше 10 MiB.');
    let x;try{x=JSON.parse(text);}catch{fail('Файл не является корректным JSON.');}
    if(!x||x.schemaVersion!==1)fail('Неизвестная версия резервной копии.');
    if(!isoTime(x.exportedAt)||typeof x.displayName!=='string'||!x.displayName.trim()||x.displayName.length>80)fail('Некорректные сведения резервной копии.');
    try{return {schemaVersion:1,exportedAt:x.exportedAt,displayName:x.displayName,data:cleanData(x.data)};}catch(e){fail(e instanceof TypeError?'Некорректная структура резервной копии.':e.message);}
  }
  const makeBackup=(r,now=new Date())=>({schemaVersion:1,exportedAt:now.toISOString(),displayName:r.auth.displayName,data:cleanData(r.data)});
  function exportStatus(r,now=new Date()){
    const last=r.localMeta.lastExportRequestedAt,zone=r.data.settings.timeZone;
    const elapsed=last?Math.floor((Date.parse(today(zone,now))-Date.parse(today(zone,new Date(last))))/86400000):null;
    return {due:!last||elapsed>=7||r.localMeta.changesSinceExport>=20,label:last?'Экспорт: '+today(zone,new Date(last)):'Экспорт: ещё не выполнялся'};
  }
  function backupFilename(zone,now=new Date()){
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
    return 'payment-calendar-'+today(zone,now)+'-'+parts.find(p=>p.type==='hour').value+parts.find(p=>p.type==='minute').value+'.json';
  }
  const storedOperations = d => [...d.operations, ...d.exceptions.filter(e=>!e.deleted).map(e=>e.operation)];
  const ruleAt = (series, month) => series.versions.filter(v=>v.effectiveFrom<=month).at(-1);
  function recurringDate(month, rule) {
    const day=Math.min(rule.dayOfMonth,days(month));
    const dt=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7))-1,day));
    if(rule.shiftWeekend){const w=dt.getUTCDay();if(w===6)dt.setUTCDate(dt.getUTCDate()+2);else if(w===0)dt.setUTCDate(dt.getUTCDate()+1);}
    return dt.toISOString().slice(0,10);
  }
  function virtualOperation(series,month) {
    const v=ruleAt(series,month);
    if(!v || month<v.firstMonth || (v.lastMonth && month>v.lastMonth))return null;
    const date=recurringDate(month,v);
    if(!validDate(date))return null; // A weekend shift past 2100 lies outside the supported calendar.
    return {id:series.id+':'+month,rowId:v.rowId,amountMinor:v.amountMinor,plannedDate:date,title:v.title,comment:v.comment,cancelledMinor:0,settlements:[],createdAt:month+'-01T00:00:00.000Z',updatedAt:month+'-01T00:00:00.000Z'};
  }
  function projectedOperations(d,month) {
    const result=[...d.operations,...d.exceptions.filter(e=>!e.deleted).map(e=>({...e.operation,id:e.occurrenceKey}))];
    const overridden=new Set(d.exceptions.map(e=>e.occurrenceKey));
    for(const series of d.series)for(const source of [shiftMonth(month,-1),month]) {
      if(!validMonth(source)||source<d.settings.firstMonth||overridden.has(series.id+':'+source))continue;
      const o=virtualOperation(series,source);if(o)result.push(o);
    }
    return result;
  }
  function getOperation(d,id,materialize=false,newId) {
    if(!id.includes(':')) {const o=d.operations.find(o=>o.id===id);if(!o)fail('Операция не найдена.');return o;}
    const [seriesId,sourceMonth]=id.split(':');const series=d.series.find(s=>s.id===seriesId);
    if(!series||!validMonth(sourceMonth))fail('Повторение не найдено.');
    const e=d.exceptions.find(e=>e.occurrenceKey===id);
    if(e){if(e.deleted)fail('Платёж удалён.');return e.operation;}
    const o=virtualOperation(series,sourceMonth);if(!o)fail('Платёж вне периода повторения.');
    if(materialize){o.id=newId();d.exceptions.push({occurrenceKey:id,seriesId,sourceMonth,deleted:false,operation:o});}
    return o;
  }
  function deleteOperation(d,id) {
    if(!id.includes(':')){d.operations=d.operations.filter(o=>o.id!==id);return;}
    getOperation(d,id);const [seriesId,sourceMonth]=id.split(':');d.exceptions=d.exceptions.filter(e=>e.occurrenceKey!==id);d.exceptions.push({occurrenceKey:id,seriesId,sourceMonth,deleted:true,operation:null});
  }
  function changeSeries(d,id,values) {
    const [seriesId,sourceMonth]=id.split(':'),series=d.series.find(s=>s.id===seriesId),selected=getOperation(d,id);
    if(!series||!validMonth(values.firstMonth)||values.firstMonth>sourceMonth||(values.lastMonth&&values.lastMonth<sourceMonth))fail('Исходный месяц выбранного платежа должен входить в новый период.','lastMonth');
    series.versions=series.versions.filter(v=>v.effectiveFrom<sourceMonth);
    series.versions.push({...values,effectiveFrom:sourceMonth});
    if(!selected.settlements.length&&selected.cancelledMinor===0)d.exceptions=d.exceptions.filter(e=>e.occurrenceKey!==id);
  }
  function stopSeries(d,seriesId,lastMonth) {
    const series=d.series.find(s=>s.id===seriesId);
    if(!series||!validMonth(lastMonth)||lastMonth<series.versions[0].firstMonth)fail('Последний месяц должен быть не раньше начала серии.','lastMonth');
    // Drop later rule changes so that they cannot restart a stopped series.
    series.versions=series.versions.filter(v=>v.effectiveFrom<=lastMonth).map(v=>({...v,lastMonth:v.lastMonth&&v.lastMonth<lastMonth?v.lastMonth:lastMonth}));
  }
  const remaining = o => add(add(o.amountMinor,-paid(o)),-o.cancelledMinor);
  function fragments(o) {
    const result=o.settlements.map(p=>({...o,amountMinor:p.amountMinor,date:p.actualDate,partId:p.id,kind:'settled',createdAt:p.createdAt}));
    const amount=remaining(o);if(amount>0)result.push({...o,amountMinor:amount,date:o.plannedDate,partId:null,kind:'planned'});
    return result;
  }
  function settle(o, amount, date, partId, newId, now, firstMonth, currentDate) {
    if(!Number.isSafeInteger(amount)||amount<=0)fail('Укажите положительную сумму.','amount');
    if(!validDate(date)||date.slice(0,7)<firstMonth||date>currentDate)fail('Фактическая дата должна быть в периоде учёта и не позже сегодняшней.','actualDate');
    const target=partId?o.settlements.find(p=>p.id===partId):null;
    if(partId&&!target)fail('Исполненная часть не найдена.');
    if(!partId&&remaining(o)<=0)fail('У операции нет неоплаченного остатка.');
    const total=add(add(paid(o),-(target?target.amountMinor:0)),amount);
    const newAmount=Math.max(o.amountMinor,add(total,o.cancelledMinor));
    if(target){target.amountMinor=amount;target.actualDate=date;}else o.settlements.push({id:newId,amountMinor:amount,actualDate:date,createdAt:now});
    o.amountMinor=newAmount;o.updatedAt=now;
  }
  function unSettle(o,id,now) {if(!o.settlements.some(p=>p.id===id))fail('Исполненная часть не найдена.');o.settlements=o.settlements.filter(p=>p.id!==id);o.updatedAt=now;}
  function moveRemainder(o,date,firstMonth,now) {if(remaining(o)<=0)fail('У операции нет неоплаченного остатка.');if(!validDate(date)||date.slice(0,7)<firstMonth)fail('Дата должна быть в периоде учёта.','plannedDate');o.plannedDate=date;o.updatedAt=now;}
  function cancelRemainder(o,now) {if(remaining(o)<=0)fail('Нет остатка для отмены.');o.cancelledMinor=add(o.cancelledMinor,remaining(o));o.updatedAt=now;}
  function restoreRemainder(o,date,firstMonth,now) {if(o.cancelledMinor<=0)fail('Нет отменённой суммы.');if(!validDate(date)||date.slice(0,7)<firstMonth)fail('Выберите дату в периоде учёта.','plannedDate');o.cancelledMinor=0;o.plannedDate=date;o.updatedAt=now;}
  function editOperation(o,values,now) {if(o.settlements.length&&own(values,'rowId')&&values.rowId!==o.rowId)fail('Сначала отмените исполнения, чтобы изменить строку.','rowId');if(values.amountMinor<add(paid(o),o.cancelledMinor))fail('Общая сумма не может быть меньше исполненной и отменённой суммы.','amount');Object.assign(o,values,{updatedAt:now});}
  function flows(d, m, totalsOnly=false) {
    const income = Array(days(m)).fill(0), expense = Array(days(m)).fill(0), rowTotals = new Map(), cells = new Map();
    const rows = new Map(d.rows.map(r => [r.id, r]));
    for (const operation of projectedOperations(d,m)) for(const o of fragments(operation)) {
      if (o.date.slice(0, 7) !== m) continue;
      const i = Number(o.date.slice(8)) - 1, arr = rows.get(o.rowId).type === 'income' ? income : expense;
      arr[i] = add(arr[i], o.amountMinor); if(totalsOnly)continue;rowTotals.set(o.rowId, add(rowTotals.get(o.rowId) || 0, o.amountMinor));
      const key = o.rowId + ':' + (i + 1); if (!cells.has(key)) cells.set(key, []); cells.get(key).push(o);
    }
    for (const list of cells.values()) list.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || (a.partId||a.id).localeCompare(b.partId||b.id));
    return { income, expense, rowTotals, cells, incomeTotal: sum(income), expenseTotal: sum(expense) };
  }
  function opening(d, m, cache = new Map()) {
    if (m < d.settings.firstMonth) return 0;
    if (own(d.openingBalances, m)) return d.openingBalances[m];
    let i = monthIndex(m) - 1, trail = [];
    while (i >= monthIndex(d.settings.firstMonth)) {
      const t = fromIndex(i);
      if (cache.has(t)) break;
      trail.push(t); if (own(d.openingBalances, t)) break; i--;
    }
    let b = 0;
    if (cache.has(fromIndex(i))) b = cache.get(fromIndex(i));
    for (const t of trail.reverse()) { if (own(d.openingBalances, t)) b = d.openingBalances[t]; const f = flows(d, t, true); b = add(add(b, f.incomeTotal), -f.expenseTotal); cache.set(t, b); }
    return b;
  }
  function calculate(d, m, cache = new Map()) {
    const f = flows(d, m), start = opening(d, m, cache), balances = []; let b = start;
    for (let j = 0; j < days(m); j++) { b = add(add(b, f.income[j]), -f.expense[j]); balances.push(b); }
    if (m >= d.settings.firstMonth) cache.set(m, b);
    return { ...f, start, balances, end: b };
  }
  function invalidate(cache, before, after) {
    if (before.settings.firstMonth !== after.settings.firstMonth || JSON.stringify(before.series)!==JSON.stringify(after.series)) { cache.clear(); return; }
    const touched = new Set(); const a = new Map(before.operations.map(o=>[o.id,o])), b = new Map(after.operations.map(o=>[o.id,o]));
    for (const id of new Set([...a.keys(), ...b.keys()])) if (JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id))) { for(const o of [a.get(id),b.get(id)]) if(o) for(const date of [o.plannedDate,...o.settlements.map(p=>p.actualDate)]) touched.add(date.slice(0,7)); }
    const oldExceptions=new Map(before.exceptions.map(e=>[e.occurrenceKey,e])),newExceptions=new Map(after.exceptions.map(e=>[e.occurrenceKey,e]));
    for(const key of new Set([...oldExceptions.keys(),...newExceptions.keys()]))if(JSON.stringify(oldExceptions.get(key))!==JSON.stringify(newExceptions.get(key))){
      const [sid,source]=key.split(':');
      for(const d of [before,after]){const e=d.exceptions.find(e=>e.occurrenceKey===key),o=e?(e.deleted?null:e.operation):virtualOperation(d.series.find(s=>s.id===sid),source);if(o)for(const date of [o.plannedDate,...o.settlements.map(p=>p.actualDate)])touched.add(date.slice(0,7));}
    }
    for (const m of new Set([...Object.keys(before.openingBalances), ...Object.keys(after.openingBalances)])) if (before.openingBalances[m] !== after.openingBalances[m]) touched.add(m);
    for (const m of touched) { const next = Object.keys(after.openingBalances).filter(k=>k>m).sort()[0]; for (const k of cache.keys()) if(k>=m && (!next || k<next)) cache.delete(k); }
  }
  const modeKey = type => type === 'income' ? 'incomeSortMode' : 'expenseSortMode';
  const tie = (a,b) => a.name.localeCompare(b.name, 'ru') || a.id.localeCompare(b.id);
  function sortedRows(d, type, totals, groupId = null, includeArchived = false) {
    return d.rows.filter(r => r.type === type && r.groupId === groupId && (includeArchived || !r.archived || (totals.get(r.id)||0)>0)).sort((a,b) => d.settings[modeKey(type)] === 'amount' ? (totals.get(b.id)||0) - (totals.get(a.id)||0) || tie(a,b) : a.order-b.order || tie(a,b));
  }
  function sortedGroups(d, totals) {
    return [{ id: '', name: 'Без группы', order: d.settings.ungroupedExpenseOrder }, ...d.groups].map(g => ({...g, total: sum(d.rows.filter(r=>r.type==='expense' && r.groupId===(g.id||null)).map(r=>totals.get(r.id)||0))})).sort((a,b) => d.settings.expenseSortMode==='amount' ? b.total-a.total || tie(a,b) : a.order-b.order || tie(a,b));
  }
  function canMoveItem(d,kind,id,delta,m){
    if(delta!==-1&&delta!==1)return false;
    const totals=flows(d,m).rowTotals,r=kind==='row'?d.rows.find(x=>x.id===id):null;
    if(kind==='row'&&!r)return false;
    const list=kind==='row'?sortedRows(d,r.type,totals,r.groupId,true):kind==='group'?sortedGroups(d,totals):[];
    const i=list.findIndex(x=>x.id===id);return i>=0&&i+delta>=0&&i+delta<list.length;
  }
  function moveItem(d, kind, id, delta, m) {
    if(!canMoveItem(d,kind,id,delta,m))return false;
    const totals = flows(d,m).rowTotals; const r = kind==='row' ? d.rows.find(x=>x.id===id) : null; const type = r ? r.type : 'expense';
    const scopes = type==='income' ? [null] : [null,...d.groups.map(g=>g.id)];
    if (d.settings[modeKey(type)]==='amount') {
      for(const gid of scopes) { const visible = sortedRows(d,type,totals,gid); const hidden = d.rows.filter(x=>x.type===type&&x.groupId===gid&&!visible.includes(x)).sort((a,b)=>a.order-b.order); [...visible,...hidden].forEach((x,i)=>x.order=i+1); }
      if(type==='expense') sortedGroups(d,totals).forEach((g,i)=> { if(g.id) d.groups.find(x=>x.id===g.id).order=i+1; else d.settings.ungroupedExpenseOrder=i+1; });
      d.settings[modeKey(type)]='manual';
    }
    const list = kind==='row' ? sortedRows(d,type,totals,r.groupId,true) : sortedGroups(d,totals);
    const i = list.findIndex(x=>x.id===id), j=i+delta; if(i<0 || j<0 || j>=list.length) return;
    [list[i],list[j]]=[list[j],list[i]];
    list.forEach((x,k)=> { if(kind==='row') x.order=k+1; else if(x.id) d.groups.find(g=>g.id===x.id).order=k+1; else d.settings.ungroupedExpenseOrder=k+1; });
  }
  function compactOrders(d) { for(const type of ['income','expense']) for(const gid of [null,...d.groups.map(g=>g.id)]) d.rows.filter(r=>r.type===type&&r.groupId===gid).sort((a,b)=>a.order-b.order).forEach((r,i)=>r.order=i+1); }
  function commit(storage, current, expectedRaw, change) {
    if(storage.getItem(KEY)!==expectedRaw) fail('Данные изменены в другом окне. Перечитайте их перед сохранением.');
    const next=clone(current); change(next); next.revision=safe(current.revision+1); next.updatedAt=new Date().toISOString();
    if(JSON.stringify(next.data)!==JSON.stringify(current.data)) next.localMeta.changesSinceExport=safe(next.localMeta.changesSinceExport+1);
    validateRoot(next); const raw=JSON.stringify(next);
    if(storage.getItem(KEY)!==expectedRaw) fail('Данные изменены в другом окне. Перечитайте их.');
    storage.setItem(KEY,raw); return {root:next,raw};
  }
  return {KEY,own,clone,fail,safe,add,sum,money,formatMoney,moneyInput,validMonth,monthIndex,fromIndex,shiftMonth,days,validDate,today,normalize,blank,validateData,validateRoot,paid,remaining,fragments,settle,unSettle,moveRemainder,cancelRemainder,restoreRemainder,editOperation,flows,opening,calculate,invalidate,modeKey,sortedRows,sortedGroups,canMoveItem,moveItem,compactOrders,commit,storedOperations,ruleAt,recurringDate,virtualOperation,projectedOperations,getOperation,deleteOperation,changeSeries,stopSeries,cleanData,readBackup,makeBackup,exportStatus,backupFilename};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CalendarCore;

// 2. Local authentication (Web Crypto); only invoked from the browser.
const CalendarAuth = {
  base64(bytes) { return btoa(String.fromCharCode(...bytes)); },
  bytes(s) { return Uint8Array.from(atob(s),c=>c.charCodeAt(0)); },
  async derive(password,salt) { const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000},key,256)); },
  async create(name,password) { const salt=crypto.getRandomValues(new Uint8Array(16)); return {displayName:name,passwordAlgorithm:'PBKDF2-SHA-256',iterations:600000,saltBase64:this.base64(salt),verifierBase64:this.base64(await this.derive(password,salt))}; },
  async verify(password,auth) { const got=await this.derive(password,this.bytes(auth.saltBase64)); const expected=this.bytes(auth.verifierBase64); let v=got.length^expected.length; for(let i=0;i<got.length;i++) v|=got[i]^expected[i]; return v===0; }
};

// 3. Browser UI and commands. Not initialized when required by Node tests.
if (typeof window !== 'undefined' && typeof document !== 'undefined') (() => {
  const C=CalendarCore, app=document.getElementById('app'), modal=document.getElementById('modal');
  let root=null, raw=null, session=false, viewMonth='', dateNow='', cache=new Map(), managerType='income', noticeTimer, dayTimer, conflict=false;
  let undoState=null, undoTimer=null, drag=null, suppressClickUntil=0;
  const expanded=new Set(); const months=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  function el(tag,attrs={},...children) { const n=document.createElement(tag); for(const [k,v] of Object.entries(attrs)) { if(k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(),v); else if(k==='class') n.className=v; else if(k==='text') n.textContent=v; else if(v!==null&&v!==false) n.setAttribute(k,v===true?'':String(v)); } for(const c of children.flat()) if(c!==null&&c!==undefined) n.append(c instanceof Node?c:document.createTextNode(String(c))); return n; }
  const btn=(text,fn,cls='',attrs={})=>el('button',{type:'button',class:cls,onClick:fn,...attrs},text);
  const logo=()=>el('div',{class:'brand'},el('span',{class:'brand-mark','aria-hidden':true},'▦'),'Платёжный календарь');
  function notify(text) { const n=document.getElementById('notice'); n.textContent=text; clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>n.textContent='',4500); }
  function clearUndo(){undoState=null;clearTimeout(undoTimer);const bar=document.getElementById('undo-bar');bar.replaceChildren();bar.hidden=true;}
  function offerUndo(operations,label){
    undoState={operations,expires:Date.now()+10000};const bar=document.getElementById('undo-bar');bar.replaceChildren(document.createTextNode(label+' '),btn('Отменить',()=>{
      if(!undoState||Date.now()>=undoState.expires){clearUndo();return;}
      const snapshot=undoState.operations;
      try{save(r=>{r.data.operations=C.clone(snapshot.operations);r.data.exceptions=C.clone(snapshot.exceptions);});notify('Действие отменено');}catch(e){notify(e.message);}
    },'small'));bar.hidden=false;undoTimer=setTimeout(clearUndo,10000);
  }
  const operation = (r,id) => C.getOperation(r.data,id,r!==root,()=>crypto.randomUUID());
  function field(form,label,name,type='text',value='',opts={}) {
    const input=el(type==='select'?'select':type==='textarea'?'textarea':'input',{name,id:'f-'+name,...(type!=='select'&&type!=='textarea'?{type}:{}),...opts});
    input.value=type==='checkbox'?'on':value; const err=el('span',{class:'field-error',id:'err-'+name}); input.setAttribute('aria-describedby','err-'+name);
    const wrap=el('label',{class:'field'+(type==='checkbox'?' check-field':'')},el('span',{},label),input,err); form.append(wrap); return input;
  }
  function option(select,value,label) { select.append(el('option',{value},label)); }
  function errors(form,e) { form.querySelectorAll('.field-error,.form-error').forEach(n=>n.textContent=''); const near=e.field&&form.querySelector('[name="'+e.field+'"]'); const target=near?near.closest('.field').querySelector('.field-error'):form.querySelector('.form-error'); if(target) target.textContent=e.message||'Не удалось выполнить действие.'; if(near) {near.setAttribute('aria-invalid','true');near.focus();} }
  function bindForm(form,handler) { form.append(el('p',{class:'form-error',role:'alert'})); form.addEventListener('input',e=>e.target.removeAttribute('aria-invalid')); form.addEventListener('submit',async e=> { e.preventDefault(); const submit=form.querySelector('[type=submit]'); if(submit.disabled)return; submit.disabled=true; try { await handler(Object.fromEntries(new FormData(form))); } catch(e) { errors(form,e); } finally {submit.disabled=false;} }); return form; }
  function openDialog(title,wide=false) { if(modal.open)modal.close(); modal.replaceChildren(); modal.className=wide?'wide':''; modal.append(el('div',{class:'dialog-head'},el('h2',{id:'modal-title'},title),btn('×',()=>modal.close(),'close-btn',{'aria-label':'Закрыть'}))); modal.showModal(); return modal; }
  function formActions(form,label='Сохранить',extras=[]) { form.append(el('div',{class:'actions'},extras,btn('Отмена',()=>modal.close()),el('button',{type:'submit',class:'primary'},label))); }
  function showConfirm(title,text,fn,back) { const d=openDialog(title);d.append(el('p',{class:'muted'},text));const f=el('form');bindForm(f,async()=>{await fn();if(modal.open)modal.close();if(back)back();});formActions(f,'Подтвердить');d.append(f); }
  function probe() { const key='paymentCalendar.probe';localStorage.setItem(key,'1');localStorage.removeItem(key); }
  function downloadRaw(text,filename='payment-calendar-recovery.json') { const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=el('a',{href:url,download:filename,hidden:true});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000); }
  function block(message,source=null) { session=false;clearUndo();cancelDrag(); if(modal.open)modal.close(); const box=el('section',{class:'blocking'},el('h1',{},'Данные требуют внимания'),el('p',{},message));if(source!==null)box.append(btn('Скачать исходные данные',()=>downloadRaw(source)));box.append(btn('Заменить профиль из резервной копии',()=>showImport(true)),btn('Проверить снова',()=>boot()));app.replaceChildren(box); }
  function save(change,undoLabel=null) {
    checkDate(); if(!session)C.fail('Войдите снова.');
    if(conflict)C.fail('Есть изменения в другом окне. Закройте форму и нажмите «Перечитать данные».');
    try { const snapshot=undoLabel?C.clone({operations:root.data.operations,exceptions:root.data.exceptions}):null;const result=C.commit(localStorage,root,raw,change);C.invalidate(cache,root.data,result.root.data);clearUndo();root=result.root;raw=result.raw;renderCalendar(false);notify('Сохранено в этом браузере');if(undoLabel)offerUndo(snapshot,undoLabel); }
    catch(e) { if(e.name==='QuotaExceededError'||e.name==='SecurityError') C.fail('Не удалось сохранить данные браузера. Изменение не применено. Освободите место; сохраните исходные данные из справки.');throw e; }
  }
  function reloadData() {clearUndo();cancelDrag(); const old=root&&JSON.stringify(root.auth);try { const nextRaw=localStorage.getItem(C.KEY);if(!nextRaw){boot();return;}const next=C.validateRoot(JSON.parse(nextRaw));root=next;raw=nextRaw;cache.clear();conflict=false;if(modal.open)modal.close();if(old!==JSON.stringify(next.auth)){session=false;renderAuth();}else renderCalendar(false); }catch(e){block(e.message,localStorage.getItem(C.KEY));} }
  function detectExternal() {
    if(!root)return;let current;try{current=localStorage.getItem(C.KEY);}catch{block('Хранилище браузера недоступно.');return;}
    if(current===raw)return;
    clearUndo();cancelDrag();
    try {const next=current?C.validateRoot(JSON.parse(current)):null;if(!next||JSON.stringify(next.auth)!==JSON.stringify(root.auth)){session=false;boot();return;}conflict=true; if(session) {let banner=document.getElementById('conflict');if(!banner){banner=el('div',{id:'conflict',class:'help',role:'alert'},'Данные изменены в другом окне. ',btn('Перечитать данные',reloadData,'small'));app.prepend(banner);}} }catch(e){block('Сохранённые данные повреждены. '+e.message,current);}
  }
  function renderAuth() {
    session=false;clearUndo();cancelDrag(); if(modal.open)modal.close(); modal.replaceChildren(); const registration=!root; const card=el('section',{class:'auth-card'},logo(),el('div',{class:'eyebrow'},'Личный финансовый план'),el('h1',{},registration?'Создайте локальный профиль':'С возвращением'+(root?', '+root.auth.displayName:'')));if(registration)card.append(el('p',{class:'muted'},'Планируйте поступления и расходы. Ваш календарь хранится только в этом браузере.'));
    const f=el('form');if(registration)field(f,'Ваше имя','name','text','',{required:true,maxlength:80,autocomplete:'name'});
    field(f,'Пароль','password','password','',{required:true,minlength:8,maxlength:128,autocomplete:registration?'new-password':'current-password'});
    if(registration) {field(f,'Повторите пароль','repeat','password','',{required:true,minlength:8,maxlength:128,autocomplete:'new-password'});card.append(el('div',{class:'help'},'Это локальная блокировка экрана. Данные не зашифрованы; интернет-аккаунта и восстановления по почте нет.'));}
    bindForm(f,async v=> {
      if(registration) {if(v.password!==v.repeat)C.fail('Пароли не совпадают.','repeat');if(!v.name.trim())C.fail('Укажите имя.','name');const auth=await CalendarAuth.create(v.name.trim(),v.password);showSetup(auth);}
      else {const auth=C.clone(root.auth);if(!await CalendarAuth.verify(v.password,auth))C.fail('Неверный пароль.','password');if(localStorage.getItem(C.KEY)!==raw){boot();C.fail('Профиль изменился. Повторите вход.');}session=true;dateNow=C.today(root.data.settings.timeZone);viewMonth=dateNow.slice(0,7);renderCalendar(true);}
    });f.append(el('div',{class:'actions'},el('button',{type:'submit',class:'primary'},registration?'Продолжить':'Войти')));card.append(f,el('p',{class:'muted',style:'margin-top:22px;margin-bottom:20px'},'Локально · Без сервера · Рубли'),btn('Заменить профиль из резервной копии',()=>showImport(true),'small'));app.replaceChildren(el('div',{class:'auth-shell'},card));
  }
  function showSetup(auth) {
    const d=openDialog('Начало учёта');d.append(el('p',{class:'muted'},'Сумма относится к первому числу выбранного месяца. Пустые дни будут показывать этот остаток.'));const f=el('form');field(f,'Первый месяц','firstMonth','month',C.today('Asia/Yekaterinburg').slice(0,7),{required:true,min:'1900-01',max:'2100-12'});field(f,'Остаток на первое число, ₽','amount','text','0,00',{required:true,inputmode:'decimal'});bindForm(f,v=>{
      if(!C.validMonth(v.firstMonth))C.fail('Выберите месяц от 1900 до 2100 года.','firstMonth');const data=C.blank(v.firstMonth,C.money(v.amount,true));const next={schemaVersion:1,revision:1,updatedAt:new Date().toISOString(),auth,data,localMeta:{lastExportRequestedAt:null,changesSinceExport:0}};C.validateRoot(next);if(localStorage.getItem(C.KEY)!==null)C.fail('Профиль уже создан в другом окне. Перезагрузите страницу.');const nextRaw=JSON.stringify(next);localStorage.setItem(C.KEY,nextRaw);root=next;raw=nextRaw;session=true;dateNow=C.today(data.settings.timeZone);viewMonth=dateNow.slice(0,7);modal.close();renderCalendar(true);
    });formActions(f,'Открыть календарь');d.append(f);
  }
  // Pointer-based dragging: only the remaining planned part can move.
  function cancelDrag(){
    if(!drag)return;const current=drag;drag=null;cancelAnimationFrame(current.frame);
    if(current.active)suppressClickUntil=performance.now()+350;
    if(current.target)current.target.classList.remove('drop-target');
    if(current.ghost)current.ghost.remove();current.card.classList.remove('drag-source');
    if(current.card.hasPointerCapture(current.pointerId))current.card.releasePointerCapture(current.pointerId);
    document.body.classList.remove('dragging-payment');
  }
  function dragTarget(){
    if(!drag||!drag.active)return;
    if(drag.target)drag.target.classList.remove('drop-target');drag.target=null;
    const box=drag.shell.getBoundingClientRect(),left=drag.shell.querySelector('thead th').getBoundingClientRect().right;
    const top=drag.shell.querySelector('thead').getBoundingClientRect().bottom,bottom=drag.shell.querySelector('tfoot').getBoundingClientRect().top;
    if(drag.x<=left||drag.x>=box.right||drag.y<=top||drag.y>=bottom)return;
    const hit=document.elementFromPoint(drag.x,drag.y),cell=hit&&hit.closest('td.day-cell');
    if(cell&&cell.dataset.row===drag.rowId&&!cell.hidden){drag.target=cell;cell.classList.add('drop-target');}
  }
  function dragFrame(time){
    if(!drag||!drag.active)return;
    const dt=drag.lastTime?Math.min(50,time-drag.lastTime):0;drag.lastTime=time;
    const box=drag.shell.getBoundingClientRect(),left=drag.shell.querySelector('thead th').getBoundingClientRect().right;
    let speed=0;
    if(drag.y>box.top&&drag.y<box.bottom&&drag.x>=left&&drag.x<=box.right){
      if(drag.x<left+32)speed=-600*(left+32-drag.x)/32;
      else if(drag.x>box.right-32)speed=600*(drag.x-(box.right-32))/32;
    }
    if(speed)drag.shell.scrollLeft+=speed*dt/1000;
    drag.ghost.style.left=(drag.x+14)+'px';drag.ghost.style.top=(drag.y+14)+'px';dragTarget();
    drag.frame=requestAnimationFrame(dragFrame);
  }
  function beginPointer(e,card,part){
    if(e.button!==0||e.target.closest('input,button,label')||part.kind!=='planned'||drag)return;
    drag={card,pointerId:e.pointerId,operationId:part.id,rowId:part.rowId,originalDate:part.date,startX:e.clientX,startY:e.clientY,x:e.clientX,y:e.clientY,active:false,shell:card.closest('.table-shell')};
  }
  function pointerMove(e){
    if(!drag||e.pointerId!==drag.pointerId)return;drag.x=e.clientX;drag.y=e.clientY;
    if(!drag.active&&Math.hypot(drag.x-drag.startX,drag.y-drag.startY)>=5){
      drag.active=true;drag.card.setPointerCapture(drag.pointerId);drag.card.classList.add('drag-source');document.body.classList.add('dragging-payment');
      drag.ghost=el('div',{class:'drag-ghost'},drag.card.querySelector('.amount').textContent);document.body.append(drag.ghost);drag.frame=requestAnimationFrame(dragFrame);
    }
    if(drag.active){e.preventDefault();dragTarget();}
  }
  function pointerUp(e){
    if(!drag||e.pointerId!==drag.pointerId)return;
    if(drag.active){drag.x=e.clientX;drag.y=e.clientY;dragTarget();}
    const item=drag,date=item.target&&item.target.dataset.date;cancelDrag();
    if(item.active&&date&&date!==item.originalDate){try{save(r=>C.moveRemainder(operation(r,item.operationId),date,r.data.settings.firstMonth,new Date().toISOString()),'Дата платежа изменена.');}catch(error){notify(error.message);}}
    checkDate();
  }
  function navigate(m) {if(!C.validMonth(m))return;cancelDrag();viewMonth=m;expanded.clear();renderCalendar(true);}
  function renderCalendar(focusDay=false) {
    if(!session)return; const old=document.querySelector('.table-shell'),scroll=old?{left:old.scrollLeft,top:old.scrollTop}:{left:0,top:0};
    let calc;try{calc=C.calculate(root.data,viewMonth,cache);}catch(e){block(e.message,raw);return;}
    const d=root.data; const ws=el('section',{class:'workspace'});
    ws.append(el('header',{class:'topbar',id:'main-menu',hidden:!!d.settings.topbarCollapsed},logo(),el('div',{class:'topbar-right'},el('span',{class:'muted'},root.auth.displayName+' · '+d.settings.timeZone),btn('Строки и группы',()=>showManager()),btn('Профиль',showProfile),el('div',{class:'backup-tools'},btn('Скачать JSON',()=>exportBackup(),C.exportStatus(root).due?'small primary':'small'),el('span',{class:'save-state',title:'Последний запуск экспорта; проверьте файл в загрузках'},C.exportStatus(root).label)),btn('Загрузить JSON',()=>showImport(false),'small'),btn('Выйти',()=>{session=false;cache.clear();renderAuth();},'quiet'))));
    const nav=el('div',{class:'navigation'},btn('←',()=>navigate(C.shiftMonth(viewMonth,-1)),'',{'aria-label':'Предыдущий месяц',disabled:viewMonth==='1900-01'}));
    const ms=el('select',{'aria-label':'Месяц',onChange:e=>navigate(viewMonth.slice(0,4)+'-'+e.target.value)});months.forEach((m,i)=>option(ms,String(i+1).padStart(2,'0'),m));ms.value=viewMonth.slice(5);nav.append(ms);
    const yr=el('input',{type:'number',min:1900,max:2100,value:viewMonth.slice(0,4),'aria-label':'Год',onChange:e=>{const y=e.target.value;if(/^\d{4}$/.test(y)&&C.validMonth(y+viewMonth.slice(4)))navigate(y+viewMonth.slice(4));else e.target.value=viewMonth.slice(0,4);}});nav.append(yr,btn('→',()=>navigate(C.shiftMonth(viewMonth,1)),'',{'aria-label':'Следующий месяц',disabled:viewMonth==='2100-12'}),btn('Сегодня',()=>navigate(C.today(d.settings.timeZone).slice(0,7))));
    nav.append(btn(d.settings.topbarCollapsed?'Меню ↓':'Скрыть меню ↑',()=>{try{save(r=>r.data.settings.topbarCollapsed=!r.data.settings.topbarCollapsed);document.getElementById('menu-toggle').focus();}catch(e){notify(e.message);}},'small',{'id':'menu-toggle','aria-controls':'main-menu','aria-expanded':String(!d.settings.topbarCollapsed)}));
    ws.append(el('div',{class:'page-head'},el('div',{},el('h1',{},'Платёжный календарь на '+months[Number(viewMonth.slice(5))-1]+' '+viewMonth.slice(0,4))),nav));
    const before=viewMonth<d.settings.firstMonth;
    const source=C.own(d.openingBalances,viewMonth)?'Введено вручную':'Прогноз из предыдущего месяца';
    ws.append(el('div',{class:'balance-bar'},el('div',{class:'opening'},el('span',{class:'opening-label'},'Остаток на начало месяца'),el('span',{class:'opening-value'},C.formatMoney(calc.start)),btn('Изменить',showOpening,'small',{disabled:before}),el('span',{class:'muted'},before?'До начала учёта':source)),btn('+ Добавить операцию',()=>showOperation(),'primary',{disabled:before})));
    if(before)ws.append(el('p',{class:'help',style:'margin:0'},'Учёт начинается с '+d.settings.firstMonth+'. Более ранний месяц можно задать в профиле.'));
    const hideCheck=el('input',{type:'checkbox',id:'hide-past-days',onChange:e=>{const enabled=e.target.checked;try{save(r=>r.data.settings.hidePastDays=enabled);}catch(error){e.target.checked=!!root.data.settings.hidePastDays;notify(error.message);}}});hideCheck.checked=!!d.settings.hidePastDays;
    ws.querySelector('.opening').append(el('label',{class:'day-filter',title:'В текущем месяце скрывает дни до сегодняшнего. Другие месяцы показываются целиком. Суммы и прогноз не меняются.'},hideCheck,'Скрыть прошедшие дни'));
    const shell=el('div',{class:'table-shell',tabindex:0,'aria-label':'Календарь: прокрутка по дням'});const table=el('table',{class:'calendar','aria-label':'Платежи за '+viewMonth});const width=Math.max(110,...[...calc.income,...calc.expense,...calc.balances,...d.operations.filter(o=>o.plannedDate.startsWith(viewMonth)).map(o=>o.amountMinor)].map(n=>C.formatMoney(n).length*8+22));
    const cols=el('colgroup',{},el('col',{class:'label-col'}));for(let i=0;i<C.days(viewMonth)+1;i++)cols.append(el('col',{style:'width:'+width+'px'}));table.append(cols);
    const hr=el('tr',{},el('th',{scope:'col'},'Клиенты / статьи'));for(let i=1;i<=C.days(viewMonth);i++){const date=viewMonth+'-'+String(i).padStart(2,'0');hr.append(el('th',{scope:'col','data-date':date,class:date===dateNow?'today':''},el('span',{class:'day-number'},i),' ',el('span',{class:'day-name'},'('+new Intl.DateTimeFormat('ru',{weekday:'short',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'))+')')));}hr.append(el('th',{scope:'col',class:'total-col'},'Итого'));table.append(el('thead',{},hr));
    const body=el('tbody');
    function addSection(type,label,values,total) {
      const sk=C.modeKey(type);const sort=btn(d.settings[sk]==='amount'?'По сумме ↓':'Свой порядок',()=>showSort(type),'sort-btn',{'aria-label':'Сортировка: '+label});const heading=el('th',{scope:'row'},el('div',{class:'section-label'},label,sort));heading.append(btn('+ Добавить статью',()=>showRow(null,type),'small',{style:'margin-top:7px'}));const tr=el('tr',{class:'section','data-section':type},heading);values.forEach(v=>tr.append(el('td',{},C.formatMoney(v))));tr.append(el('td',{class:'total-col'},C.formatMoney(total)));body.append(tr);
    }
    function addRow(r) {
      const grouped=r.type==='expense'&&r.groupId!==null;
      const tr=el('tr',{'data-row':r.id},el('th',{scope:'row',class:'row-label'+(grouped?' grouped-row':''),title:r.name},grouped?el('span',{class:'group-marker','aria-hidden':true},'>'):null,r.name,r.archived?el('small',{},'В архиве'):null));
      for(let day=1;day<=C.days(viewMonth);day++) {
        const date=viewMonth+'-'+String(day).padStart(2,'0'),key=r.id+':'+day,items=calc.cells.get(key)||[];
        const cell=el('td',{class:'day-cell','data-row':r.id,'data-date':date,onDblClick:e=>{if(!e.target.closest('button,input,.payment')&&!before&&!r.archived)showOperation(null,r.id,date);}});
        if(!before&&!r.archived)cell.append(btn('+',()=>showOperation(null,r.id,date),'cell-add',{'aria-label':'Добавить: '+r.name+', '+date}));
        const cards=el('div',{class:'cards'});
        for(const o of (expanded.has(key)?items:items.slice(0,3))){
          const done=o.kind==='settled',status=done?(r.type==='income'?'Получено':'Оплачено'):(o.date<dateNow?'Просрочено':'Запланировано');
          const p=el('div',{class:'payment'+(done?(r.type==='income'?' received':' paid'):(o.date<dateNow?' overdue':'')),tabindex:0,role:'button','data-operation':o.id,'data-part':o.partId||'planned',...(done?{}:{'data-planned':o.date}),title:o.title||r.name,'aria-label':r.name+' · '+C.formatMoney(o.amountMinor)+' · '+status,
            onClick:e=>{if(!e.target.closest('input')&&performance.now()>=suppressClickUntil)done?showSettlement(o.id,o.partId):showOperation(o.id);},
            onKeydown:e=>{if(e.target===p&&(e.key==='Enter'||e.key===' ')){e.preventDefault();done?showSettlement(o.id,o.partId):showOperation(o.id);}}});
          const checkbox=el('input',{type:'checkbox',class:'payment-check','aria-label':(r.type==='income'?'Получено':'Оплачено')+': '+r.name+' '+C.formatMoney(o.amountMinor),onClick:e=>e.stopPropagation(),onChange:e=>{
            e.target.checked=done;
            if(done){try{save(s=>C.unSettle(operation(s,o.id),o.partId,new Date().toISOString()),'Отметка оплаты снята.');}catch(error){notify(error.message);}}
            else showSettlement(o.id);
          }});checkbox.checked=done;
          p.append(checkbox,el('span',{class:'amount'},C.formatMoney(o.amountMinor,true)),el('span',{class:'status'},status));
          if(!done){p.addEventListener('pointerdown',e=>beginPointer(e,p,o));p.addEventListener('lostpointercapture',()=>{if(drag&&drag.card===p)cancelDrag();});}
          cards.append(p);
        }
        if(items.length>3)cards.append(btn(expanded.has(key)?'Свернуть':'Ещё '+(items.length-3),()=>{expanded.has(key)?expanded.delete(key):expanded.add(key);renderCalendar(false);},'more'));cell.append(cards);tr.append(cell);
      }tr.append(el('td',{class:'total-col'},C.formatMoney(calc.rowTotals.get(r.id)||0)));body.append(tr);
    }
    addSection('income','Доходы',calc.income,calc.incomeTotal);const ir=C.sortedRows(d,'income',calc.rowTotals);ir.forEach(addRow);
    if(!ir.length)body.append(el('tr',{class:'empty'},el('th',{}),el('td',{colspan:C.days(viewMonth)+1},'Добавьте клиента и запланируйте первое поступление')));
    addSection('expense','Расходы',calc.expense,calc.expenseTotal);let expenseCount=0;
    for(const g of C.sortedGroups(d,calc.rowTotals)){
      const list=C.sortedRows(d,'expense',calc.rowTotals,g.id||null);if(!list.length)continue;expenseCount+=list.length;
      const collapsed=!!g.id&&(d.settings.collapsedGroupIds||[]).includes(g.id);
      if(d.groups.length){
        const heading=el('th',{scope:'row'});
        if(g.id)heading.append(btn(collapsed?'+':'−',()=>{
          try{
            save(r=>{const ids=r.data.settings.collapsedGroupIds||[];r.data.settings.collapsedGroupIds=ids.includes(g.id)?ids.filter(id=>id!==g.id):[...ids,g.id];});
            document.querySelector('[data-group-toggle="'+g.id+'"]').focus({preventScroll:true});
          }catch(error){notify(error.message);}
        },'group-toggle',{'data-group-toggle':g.id,'aria-expanded':String(!collapsed),'aria-label':(collapsed?'Развернуть группу: ':'Свернуть группу: ')+g.name,title:collapsed?'Развернуть группу':'Свернуть группу'}));
        heading.append(document.createTextNode(g.name));
        const gr=el('tr',{class:'group'+(collapsed?' group-summary':''),'data-group':g.id},heading);
        for(let day=1;day<=C.days(viewMonth);day++){
          const amount=collapsed?C.sum(list.flatMap(r=>(calc.cells.get(r.id+':'+day)||[]).map(o=>o.amountMinor))):0;
          gr.append(el('td',{},collapsed?C.formatMoney(amount):''));
        }
        gr.append(el('td',{},collapsed?C.formatMoney(g.total):''));body.append(gr);
      }
      if(!collapsed)list.forEach(addRow);
    }
    if(!expenseCount)body.append(el('tr',{class:'empty'},el('th',{}),el('td',{colspan:C.days(viewMonth)+1},'Добавьте статью расхода — например, аренду или коммунальные услуги')));
    table.append(body);const foot=el('tr',{},el('th',{scope:'row'},'Прогнозный остаток'));for(const v of [...calc.balances,calc.end])foot.append(el('td',{class:v<0?'negative':''},C.formatMoney(v)));table.append(el('tfoot',{},foot));shell.append(table);ws.append(shell);
    ws.append(el('div',{class:'footer-line'},el('div',{class:'legend'},el('span',{},'Плановые'),el('span',{class:'late'},'Просроченные'),el('span',{class:'today-key'},'Сегодня')),el('div',{class:'toolbar'},el('span',{class:'save-state'},'Сохранено локально'),btn('О хранении данных',showHelp,'small quiet'))));
    app.replaceChildren(ws);updateDayVisibility();if(conflict)detectExternal();if(focusDay){shell.scrollLeft=0;shell.scrollTop=0;if(viewMonth===dateNow.slice(0,7)){const h=table.querySelector('thead [data-date="'+dateNow+'"]');shell.scrollLeft=Math.max(0,h.offsetLeft-240-width);}}else{shell.scrollLeft=scroll.left;shell.scrollTop=scroll.top;}
  }
  function exportBackup(){
    try{
      if(!session)C.fail('Войдите в профиль.');if(conflict||localStorage.getItem(C.KEY)!==raw)C.fail('Данные изменены в другом окне. Перечитайте их перед экспортом.');
      const now=new Date();downloadRaw(JSON.stringify(C.makeBackup(root,now),null,2),C.backupFilename(root.data.settings.timeZone,now));
      try{const result=C.commit(localStorage,root,raw,r=>{r.localMeta.lastExportRequestedAt=now.toISOString();r.localMeta.changesSinceExport=0;});root=result.root;raw=result.raw;renderCalendar(false);notify('Скачивание запущено. Проверьте файл в загрузках.');}
      catch{notify('Скачивание запущено, но отметку экспорта сохранить не удалось. Проверьте файл в загрузках.');}
    }catch(e){notify(e.message);}
  }
  function showImport(recovery=false){
    let expected;try{expected=localStorage.getItem(C.KEY);}catch{notify('Хранилище недоступно. Восстановление возможно после восстановления доступа к хранилищу браузера.');return;}
    const d=openDialog(recovery?'Заменить профиль из резервной копии':'Загрузить JSON'),f=el('form');
    d.append(el('p',{class:'muted'},'Выберите резервную копию платёжного календаря, не более 10 MiB. Сначала файл будет проверен; до подтверждения данные не меняются.'));
    const file=field(f,'Файл JSON','backup','file','',{accept:'.json,application/json',required:true});
    bindForm(f,async()=>{const selected=file.files[0];if(!selected)C.fail('Выберите файл.','backup');if(selected.size>10*1024*1024)C.fail('Файл больше 10 MiB.','backup');let backup;try{backup=C.readBackup(await selected.text());}catch(e){C.fail(e.message,'backup');}if(!file.isConnected||!modal.open)return;showImportConfirm(backup,recovery,expected);});
    formActions(f,'Проверить файл');d.append(f);
  }
  function showImportConfirm(backup,recovery,expected){
    const d=openDialog(recovery?'Новый профиль из копии':'Заменить финансовые данные?'),f=el('form');
    d.append(el('p',{class:'help'},'В копии: строк — '+backup.data.rows.length+', операций — '+backup.data.operations.length+', серий — '+backup.data.series.length+', исключений — '+backup.data.exceptions.length+'.'),el('p',{class:'muted'},recovery?'Старый профиль будет заменён. Все текущие данные, которых нет в копии, будут потеряны. Это создание нового профиля, а не вход в старый.':'Все финансовые данные будут заменены данными файла. Имя и пароль текущего профиля сохранятся. Объединения записей не будет.'));
    if(recovery){field(f,'Новое имя','name','text',backup.displayName,{required:true,maxlength:80});field(f,'Новый пароль','password','password','',{required:true,minlength:8,maxlength:128,autocomplete:'new-password'});field(f,'Повторите пароль','repeat','password','',{required:true,minlength:8,maxlength:128,autocomplete:'new-password'});field(f,'Для подтверждения введите ЗАМЕНИТЬ','confirm','text','',{required:true,autocomplete:'off'});}
    bindForm(f,async v=>{
      if(recovery){
        if(!v.name.trim())C.fail('Укажите имя.','name');if(v.password!==v.repeat)C.fail('Пароли не совпадают.','repeat');if(v.confirm!=='ЗАМЕНИТЬ')C.fail('Введите слово ЗАМЕНИТЬ.','confirm');
        const auth=await CalendarAuth.create(v.name.trim(),v.password);
        if(!f.isConnected||!modal.open)return;
        if(localStorage.getItem(C.KEY)!==expected)C.fail('Профиль изменился в другом окне. Начните восстановление заново.');
        let revision=0;try{const old=JSON.parse(expected);if(Number.isSafeInteger(old?.revision)&&old.revision>=0)revision=old.revision;}catch{}
        const next={schemaVersion:1,revision:C.safe(revision+1),updatedAt:new Date().toISOString(),auth,data:C.clone(backup.data),localMeta:{lastExportRequestedAt:null,changesSinceExport:0}};C.validateRoot(next);
        const nextRaw=JSON.stringify(next);if(localStorage.getItem(C.KEY)!==expected)C.fail('Данные изменены в другом окне.');
        try{localStorage.setItem(C.KEY,nextRaw);}catch{C.fail('Не удалось записать новый профиль. Старые данные сохранены.');}
        clearUndo();root=next;raw=nextRaw;session=true;conflict=false;cache.clear();
      }else{
        if(!session)C.fail('Войдите снова.');
        // Exporting a safety copy may advance revision, but never change the financial dataset or auth.
        let previous;try{previous=JSON.parse(expected);}catch{C.fail('Состояние профиля изменилось. Начните импорт заново.');}
        if(JSON.stringify(root.data)!==JSON.stringify(previous.data)||JSON.stringify(root.auth)!==JSON.stringify(previous.auth))C.fail('Данные изменились после выбора файла. Начните импорт заново.');
        save(r=>{if(JSON.stringify(r.data)===JSON.stringify(backup.data))r.localMeta.changesSinceExport=C.safe(r.localMeta.changesSinceExport+1);r.data=C.clone(backup.data);});cache.clear();
      }
      dateNow=C.today(root.data.settings.timeZone);viewMonth=dateNow.slice(0,7);modal.close();renderCalendar(true);notify(recovery?'Новый профиль создан из резервной копии.':'Данные из копии загружены.');
    });formActions(f,recovery?'Заменить профиль':'Заменить данные',recovery?[]:[btn('Скачать текущую копию',exportBackup,'small')]);d.append(f);
  }
  function showHelp(){const d=openDialog('Данные в этом браузере');d.append(el('p',{class:'muted'},'Календарь сохраняется в localStorage. Другой браузер и другой путь к файлу могут иметь отдельное хранилище. Не перемещайте папку и не очищайте данные браузера без копии. Перед переносом скачайте JSON и проверьте файл в загрузках. Для переноса в другой браузер создайте профиль и загрузите JSON либо выберите замену профиля из резервной копии. Очистка хранилища браузера удаляет данные календаря. Пароль служит локальной блокировкой, данные и копии не зашифрованы.'),btn('Скачать JSON',exportBackup,'small'),btn('Скачать исходные данные для восстановления',()=>downloadRaw(raw),'small'),el('p',{class:'muted',style:'margin-top:12px'},'Техническая копия содержит локальный проверочный хеш пароля. Это аварийное сохранение хранилища, а не обычный экспорт финансовых данных. Последний запуск экспорта не подтверждает сохранение файла: проверьте загрузки браузера.'));}
  function showSort(type){const d=openDialog('Порядок строк');d.append(el('p',{class:'muted'},'По сумме — за выбранный месяц. Свой порядок сохраняется между месяцами; меняйте его стрелками в управлении строками.'));d.append(btn('По сумме ↓',()=>{save(r=>r.data.settings[C.modeKey(type)]='amount');modal.close();},'primary'),btn('Настроить порядок',()=>showManager(type)));}
  function showOpening(){const d=openDialog('Остаток на начало месяца');const f=el('form');field(f,'Сумма на первое число, ₽','amount','text',C.moneyInput(C.opening(root.data,viewMonth,cache)),{required:true,inputmode:'decimal'});d.append(el('p',{class:'muted'},'Ручная сумма не изменится при пересчётах предыдущих месяцев.'));bindForm(f,v=>{const n=C.money(v.amount,true);save(r=>r.data.openingBalances[viewMonth]=n);modal.close();});const extras=[];if(viewMonth!==root.data.settings.firstMonth&&C.own(root.data.openingBalances,viewMonth))extras.push(btn('Использовать прогноз предыдущего месяца',()=>{try{save(r=>delete r.data.openingBalances[viewMonth]);modal.close();}catch(e){errors(f,e);}},'small'));formActions(f,'Сохранить',extras);d.append(f);}
  function showOperation(id=null,rowId=null,date=null,draft=null) {
    const existing=id?operation(root,id):null;const v=draft||existing||{rowId:rowId||'',plannedDate:date||(viewMonth===dateNow.slice(0,7)?dateNow:viewMonth+'-01'),amountMinor:null,title:'',comment:''};
    const d=openDialog(existing?'Операция':'Добавить операцию');const f=el('form');const grid=el('div',{class:'form-grid'});f.append(grid);
    const chosen=root.data.rows.find(r=>r.id===v.rowId);const type=field(grid,'Тип','type','select');option(type,'income','Доход');option(type,'expense','Расход');type.value=chosen?chosen.type:(draft&&draft.type)||'income';
    const rows=field(grid,'Клиент / статья','rowId','select','',{required:true});
    function populate(){rows.replaceChildren();option(rows,'','Выберите строку');root.data.rows.filter(r=>r.type===type.value&&(!r.archived||r.id===(existing&&existing.rowId))).forEach(r=>option(rows,r.id,r.name+(r.archived?' (архив)':'')));rows.value=v.rowId;}
    populate();type.addEventListener('change',populate);
    const locked=!!(existing&&existing.settlements.length);if(locked){type.disabled=true;rows.disabled=true;}
    const create=btn('+ Создать строку',()=> {const x=Object.fromEntries(new FormData(f));const saved={...x,amountText:x.amount};showRow(null,type.value,newId=>showOperation(id,null,null,{...saved,rowId:newId}));},'small',{disabled:locked});grid.append(create,el('span',{}));
    field(grid,'Сумма, ₽','amount','text',v.amountText!==undefined?v.amountText:v.amountMinor===null?'':C.moneyInput(v.amountMinor),{required:true,inputmode:'decimal'});
    field(grid,'Плановая дата','plannedDate','date',v.plannedDate,{required:true,min:root.data.settings.firstMonth+'-01',max:'2100-12-31'});
    const title=field(grid,'Назначение (необязательно)','title','text',v.title,{maxlength:200});title.closest('.field').classList.add('full');const comment=field(grid,'Комментарий (необязательно)','comment','textarea',v.comment,{maxlength:2000});comment.closest('.field').classList.add('full');
    if(!existing){
      const repeat=field(f,'Повторять ежемесячно','repeat','checkbox');repeat.checked=!!v.repeat;
      const settings=el('div');f.append(settings);
      const start=field(settings,'Первый исходный месяц','seriesFirst','month',v.seriesFirst||v.plannedDate.slice(0,7),{min:root.data.settings.firstMonth,max:'2100-12'});
      const day=field(settings,'Число месяца','seriesDay','number',v.seriesDay||Number(v.plannedDate.slice(8)),{min:1,max:31});
      field(settings,'Последний исходный месяц (необязательно)','seriesLast','month',v.seriesLast||'',{min:root.data.settings.firstMonth,max:'2100-12'});
      const weekend=field(settings,'Переносить выходные на следующий рабочий день','seriesWeekend','checkbox');weekend.checked=!!v.seriesWeekend;
      settings.append(el('p',{class:'muted'},'Рабочие дни — понедельник–пятница, без праздников. Дата рассчитывается по числу месяца; в коротком месяце используется последний день.'));
      const update=()=>{settings.hidden=!repeat.checked;settings.querySelectorAll('input').forEach(n=>n.disabled=!repeat.checked);start.required=day.required=repeat.checked;};repeat.addEventListener('change',update);update();
    }
    if(existing){
      f.append(el('div',{class:'operation-summary'},el('span',{},'Исполнено: '+C.formatMoney(C.paid(existing))),el('span',{},'Остаток: '+C.formatMoney(C.remaining(existing))),el('span',{},'Отменено: '+C.formatMoney(existing.cancelledMinor))));
      if(locked)f.append(el('p',{class:'muted'},'Чтобы изменить тип или строку, сначала отмените исполнения.'));
      for(const part of existing.settlements)f.append(el('div',{class:'settlement-line'},el('span',{},part.actualDate+' · '+C.formatMoney(part.amountMinor)),btn('Исправить оплату',()=>showSettlement(id,part.id),'small')));
    }
    bindForm(f,x=>{const n=C.money(x.amount);const moved=existing&&C.remaining(existing)>0&&x.plannedDate!==existing.plannedDate;save(r=> {
      const now=new Date().toISOString(),values={rowId:locked?existing.rowId:x.rowId,amountMinor:n,plannedDate:x.plannedDate,title:x.title.trim(),comment:x.comment.trim()};
      if(id)C.editOperation(operation(r,id),values,now);
      else if(x.repeat)r.data.series.push({id:crypto.randomUUID(),versions:[{effectiveFrom:x.seriesFirst,firstMonth:x.seriesFirst,lastMonth:x.seriesLast||null,rowId:values.rowId,amountMinor:n,dayOfMonth:Number(x.seriesDay),shiftWeekend:!!x.seriesWeekend,title:values.title,comment:values.comment}]});
      else r.data.operations.push({id:crypto.randomUUID(),...values,cancelledMinor:0,settlements:[],createdAt:now,updatedAt:now});
    },moved?'Дата платежа изменена.':null);modal.close();});
    const extra=[];
    if(existing){
      if(id.includes(':')){f.append(el('p',{class:'help'},'Повторение · исходный месяц '+id.split(':')[1]+'. Сохранение здесь изменяет только этот платёж.'));extra.push(btn('Этот и будущие',()=>showSeries(id),'small'),btn('Остановить серию',()=>showStop(id.split(':')[0]),'small'));}
      if(C.remaining(existing)>0){extra.push(btn('Отметить оплату',()=>showSettlement(id),'small'));extra.push(btn('Отменить остаток',()=>showConfirm('Отменить остаток?',C.formatMoney(C.remaining(existing))+' будут исключены из прогноза. Исполненные части сохранятся.',()=>save(r=>C.cancelRemainder(operation(r,id),new Date().toISOString()))),'small danger'));}
      if(existing.cancelledMinor>0)extra.push(btn('Восстановить отменённое',()=>showRestore(id),'small'));
      extra.push(btn('Удалить',()=>showConfirm('Удалить операцию?',C.formatMoney(existing.amountMinor)+' · '+existing.plannedDate+'. Исполнено: '+C.formatMoney(C.paid(existing))+'. Будут удалены операция и все её оплаты.',()=>save(r=>C.deleteOperation(r.data,id))),'danger'));
    }
    formActions(f,'Сохранить',extra);d.append(f);
  }
  function showSeries(id){
    const [sid,source]=id.split(':'),series=root.data.series.find(s=>s.id===sid),rule=C.ruleAt(series,source),selected=operation(root,id);
    const d=openDialog('Этот и будущие'),f=el('form');d.append(el('p',{class:'help'},'Новые правила действуют с исходного месяца '+source+'. Ранее изменённые вручную, отменённые, исполненные и удалённые платежи других месяцев сохранятся.'));
    const row=field(f,'Клиент / статья','rowId','select','',{required:true});root.data.rows.filter(r=>!r.archived||r.id===rule.rowId).forEach(r=>option(row,r.id,(r.type==='income'?'Доход · ':'Расход · ')+r.name));row.value=rule.rowId;
    field(f,'Сумма, ₽','amount','text',C.moneyInput(rule.amountMinor),{required:true});
    field(f,'Число месяца','dayOfMonth','number',rule.dayOfMonth,{required:true,min:1,max:31});
    field(f,'Первый исходный месяц новой версии','firstMonth','month',source,{required:true,min:root.data.settings.firstMonth,max:source});
    field(f,'Последний исходный месяц (необязательно)','lastMonth','month',rule.lastMonth||'',{min:source,max:'2100-12'});
    const weekend=field(f,'Переносить выходные на следующий рабочий день','shiftWeekend','checkbox');weekend.checked=rule.shiftWeekend;
    f.append(el('p',{class:'muted'},'Рабочие дни — понедельник–пятница, без государственных праздников.'));
    field(f,'Назначение','title','text',rule.title,{maxlength:200});field(f,'Комментарий','comment','textarea',rule.comment,{maxlength:2000});
    const preview=el('p',{class:'help',role:'status'});f.append(preview);
    const values=()=>{const x=Object.fromEntries(new FormData(f));return {rowId:x.rowId,amountMinor:C.money(x.amount),dayOfMonth:Number(x.dayOfMonth),firstMonth:x.firstMonth,lastMonth:x.lastMonth||null,shiftWeekend:!!x.shiftWeekend,title:x.title.trim(),comment:x.comment.trim()};};
    const update=()=>{try{const v=values();if(!Number.isInteger(v.dayOfMonth)||v.dayOfMonth<1||v.dayOfMonth>31)throw Error();preview.textContent=selected.settlements.length||selected.cancelledMinor?'У выбранного платежа есть исполнения или отменённая сумма: он останется прежним целиком. Изменится правило серии. Для изменения самого платежа используйте «Только этот платёж».':'Выбранный платёж: '+selected.plannedDate+' · '+C.formatMoney(selected.amountMinor)+' → '+C.recurringDate(source,v)+' · '+C.formatMoney(v.amountMinor)+'. Ручной перенос этого платежа будет сброшен.';}catch{preview.textContent='Введите сумму и число месяца для предварительного расчёта.';}};
    f.addEventListener('input',update);update();bindForm(f,()=>{save(r=>C.changeSeries(r.data,id,values()));modal.close();});formActions(f,'Применить к серии',[btn('Только этот платёж',()=>showOperation(id),'small')]);d.append(f);
  }
  function showStop(sid){
    const series=root.data.series.find(s=>s.id===sid),d=openDialog('Остановить серию'),f=el('form');
    d.append(el('p',{class:'help'},'Укажите последний исходный месяц включительно. Исполненные платежи и ручные исключения после этой границы сохранятся; их можно отменить отдельно. Перенос выходного может дать дату в следующем месяце.'));
    field(f,'Последний исходный месяц','lastMonth','month',viewMonth<series.versions[0].firstMonth?series.versions[0].firstMonth:viewMonth,{required:true,min:series.versions[0].firstMonth,max:'2100-12'});
    bindForm(f,v=>{save(r=>C.stopSeries(r.data,sid,v.lastMonth));modal.close();});formActions(f,'Остановить');d.append(f);
  }
  function showSeriesList(){
    const d=openDialog('Ежемесячные повторения',true),list=el('div',{class:'manager-list'});
    for(const s of root.data.series){const v=s.versions.at(-1),row=root.data.rows.find(r=>r.id===v.rowId);list.append(el('div',{class:'manager-item'},el('div',{class:'manager-name'},row.name+' · '+C.formatMoney(v.amountMinor),el('div',{class:'muted'},'С '+s.versions[0].firstMonth+' · по '+(v.lastMonth||'2100-12')+' · число '+v.dayOfMonth)),btn('Остановить серию',()=>showStop(s.id),'small')));}
    if(!list.children.length)list.append(el('p',{},'Повторений пока нет. Создайте операцию с флажком «Повторять ежемесячно».'));d.append(list);
  }
  function showSettlement(id,partId=null){
    const o=operation(root,id),part=partId?o.settlements.find(p=>p.id===partId):null;
    const row=root.data.rows.find(r=>r.id===o.rowId),income=row.type==='income';
    const d=openDialog(part?'Исправить оплату':income?'Отметить поступление':'Отметить оплату');
    d.append(el('p',{class:'muted'},row.name+(o.title?' · '+o.title:'')));
    const f=el('form');const amount=field(f,'Фактическая сумма, ₽','amount','text',C.moneyInput(part?part.amountMinor:C.remaining(o)),{required:true,inputmode:'decimal'});
    field(f,'Фактическая дата','actualDate','date',part?part.actualDate:C.today(root.data.settings.timeZone),{required:true,min:root.data.settings.firstMonth+'-01',max:C.today(root.data.settings.timeZone)});
    const preview=el('p',{class:'help',role:'status'});f.append(preview);
    const update=()=>{try{const n=C.money(amount.value),total=C.add(C.add(C.paid(o),-(part?part.amountMinor:0)),n),needed=C.add(total,o.cancelledMinor);preview.textContent=needed>o.amountMinor?'Общая сумма операции увеличится с '+C.formatMoney(o.amountMinor)+' до '+C.formatMoney(needed)+'. Отдельное поступление не создаётся.':'После сохранения останется: '+C.formatMoney(o.amountMinor-needed)+'.';}catch{preview.textContent='Укажите фактическую сумму с точностью до копеек.';}};amount.addEventListener('input',update);update();
    bindForm(f,v=>{const n=C.money(v.amount);save(r=>C.settle(operation(r,id),n,v.actualDate,partId,crypto.randomUUID(),new Date().toISOString(),r.data.settings.firstMonth,C.today(r.data.settings.timeZone)));modal.close();});
    formActions(f,'Сохранить',[btn('К операции',()=>showOperation(id),'small')]);d.append(f);
  }
  function showRestore(id){
    const o=operation(root,id),d=openDialog('Восстановить отменённый остаток');
    const f=el('form'),date=field(f,'Новая единая плановая дата','plannedDate','date',o.plannedDate,{required:true,min:root.data.settings.firstMonth+'-01',max:'2100-12-31'});
    const preview=el('p',{class:'help'});f.append(preview);const update=()=>preview.textContent='Будет запланировано '+C.formatMoney(C.add(C.remaining(o),o.cancelledMinor))+' на '+(date.value||'выбранную дату')+'. Существующий остаток объединится с восстановленной суммой.';date.addEventListener('input',update);update();
    bindForm(f,v=>{save(r=>C.restoreRemainder(operation(r,id),v.plannedDate,r.data.settings.firstMonth,new Date().toISOString()));showHistory();});formActions(f,'Восстановить');d.append(f);
  }
  function showHistory(){
    const d=openDialog('История отмен',true);d.append(el('p',{class:'muted'},'Отменённые остатки не участвуют в прогнозе. Показана текущая плановая дата операции.'));
    const list=el('div',{class:'manager-list'});for(const o of C.projectedOperations(root.data,viewMonth).filter(o=>o.cancelledMinor>0)){
      const row=root.data.rows.find(r=>r.id===o.rowId);list.append(el('div',{class:'manager-item'},el('div',{class:'manager-name'},el('strong',{},row.name+(row.archived?' · архив':'')),el('div',{},o.title||'Без назначения'),el('div',{class:'muted'},'Плановая дата операции: '+o.plannedDate),el('div',{},C.formatMoney(o.cancelledMinor))),el('div',{class:'manager-actions'},btn('Восстановить',()=>showRestore(o.id),'small'),btn('Операция',()=>showOperation(o.id),'small'))));
    }if(!list.children.length)list.append(el('p',{class:'muted'},'Отменённых сумм пока нет.'));d.append(list,el('div',{class:'actions'},btn('К строкам и группам',()=>showManager(),'small')));
  }
  function showRow(id=null,type='income',done=null) {
    const r=id?root.data.rows.find(x=>x.id===id):null;if(r)type=r.type;const d=openDialog(r?'Настройки строки':type==='income'?'Добавить клиента':'Добавить статью');const f=el('form');field(f,type==='income'?'Имя клиента':'Название статьи','name','text',r?r.name:'',{required:true,maxlength:120});let gs;if(type==='expense'){gs=field(f,'Группа','groupId','select');option(gs,'','Без группы');root.data.groups.forEach(g=>option(gs,g.id,g.name));gs.value=r?r.groupId||'':'';}
    bindForm(f,v=>{const newId=id||crypto.randomUUID();save(s=>{const groupId=type==='expense'?(v.groupId||null):null;const peers=s.data.rows.filter(x=>x.type===type&&x.groupId===groupId&&x.id!==id);const order=Math.max(0,...peers.map(x=>x.order))+1; if(id){const target=s.data.rows.find(x=>x.id===id);target.name=v.name.trim();if(target.groupId!==groupId){target.groupId=groupId;target.order=order;C.compactOrders(s.data);}}else s.data.rows.push({id:newId,type,name:v.name.trim(),groupId,order,archived:false});});modal.close();if(done)done(newId);else showManager(type);});formActions(f);d.append(f);
  }
  function showGroup(id=null){const g=id?root.data.groups.find(x=>x.id===id):null;const d=openDialog(g?'Переименовать группу':'Добавить группу');const f=el('form');field(f,'Название','name','text',g?g.name:'',{required:true,maxlength:120});bindForm(f,v=>{save(r=>{if(id)r.data.groups.find(x=>x.id===id).name=v.name.trim();else r.data.groups.push({id:crypto.randomUUID(),name:v.name.trim(),order:Math.max(r.data.settings.ungroupedExpenseOrder,...r.data.groups.map(x=>x.order))+1});});showManager('expense');});formActions(f);d.append(f);}
  function showManager(type=managerType) {
    managerType=type;const d=openDialog('Строки и группы',true);d.append(el('div',{class:'tabbar'},btn('Доходы',()=>showManager('income'),type==='income'?'selected':''),btn('Расходы',()=>showManager('expense'),type==='expense'?'selected':''),btn('+ '+(type==='income'?'Клиент':'Статья'),()=>showRow(null,type),'primary'),type==='expense'?btn('+ Группа',()=>showGroup()):null));
    d.append(btn('История отмен',showHistory,'small'),btn('Ежемесячные повторения',showSeriesList,'small'),el('p',{class:'muted'},'Стрелки включают свой порядок для всего блока. Архивные строки сохраняют историю, но не доступны для новых операций. Архивирование не останавливает повторения: остановите серию отдельно.'));
    const totals=C.flows(root.data,viewMonth).rowTotals;const list=el('div',{class:'manager-list'});const error=el('p',{class:'form-error',role:'alert'});d.append(error);
    const act=fn=>()=>{try{fn();showManager(type);}catch(e){error.textContent=e.message;}};
    const move=(kind,id,delta)=>{if(C.canMoveItem(root.data,kind,id,delta,viewMonth))save(r=>C.moveItem(r.data,kind,id,delta,viewMonth));};
    const scopes=type==='income'?[{id:'',name:''}]:C.sortedGroups(root.data,totals);
    for(const g of scopes){if(type==='expense'){const gh=el('div',{class:'group-heading'},el('strong',{},g.name),btn('↑',act(()=>move('group',g.id,-1)),'small',{'aria-label':'Группа выше: '+g.name,disabled:!C.canMoveItem(root.data,'group',g.id,-1,viewMonth)}),btn('↓',act(()=>move('group',g.id,1)),'small',{'aria-label':'Группа ниже: '+g.name,disabled:!C.canMoveItem(root.data,'group',g.id,1,viewMonth)}));if(g.id)gh.append(btn('Изменить',()=>showGroup(g.id),'small'),btn('Удалить',()=>showConfirm('Удалить группу?', 'Статьи перейдут в «Без группы».',()=>save(r=>{let order=Math.max(0,...r.data.rows.filter(x=>x.type==='expense'&&!x.groupId).map(x=>x.order));r.data.rows.filter(x=>x.groupId===g.id).sort((a,b)=>a.order-b.order).forEach(x=>{x.groupId=null;x.order=++order;});r.data.groups=r.data.groups.filter(x=>x.id!==g.id);r.data.settings.collapsedGroupIds=(r.data.settings.collapsedGroupIds||[]).filter(id=>id!==g.id);}),()=>showManager(type)),'small danger'));list.append(gh);}
      for(const r of C.sortedRows(root.data,type,totals,g.id||null,true)){const referenced=C.storedOperations(root.data).some(o=>o.rowId===r.id)||root.data.series.some(s=>s.versions.some(v=>v.rowId===r.id));const actions=el('div',{class:'manager-actions'},btn('↑',act(()=>move('row',r.id,-1)),'small',{'aria-label':'Выше: '+r.name,disabled:!C.canMoveItem(root.data,'row',r.id,-1,viewMonth)}),btn('↓',act(()=>move('row',r.id,1)),'small',{'aria-label':'Ниже: '+r.name,disabled:!C.canMoveItem(root.data,'row',r.id,1,viewMonth)}),btn('Изменить',()=>showRow(r.id),'small'),btn(r.archived?'Восстановить':'В архив',act(()=>save(s=>s.data.rows.find(x=>x.id===r.id).archived=!r.archived)),'small'));
        if(!referenced)actions.append(btn('Удалить',()=>showConfirm('Удалить строку?',r.name+' — строка не используется в операциях.',()=>save(s=>{s.data.rows=s.data.rows.filter(x=>x.id!==r.id);C.compactOrders(s.data);}),()=>showManager(type)),'small danger'));list.append(el('div',{class:'manager-item'+(r.archived?' archived':'')},el('span',{class:'manager-name'},r.name,r.archived?' · архив':''),actions));}
    }d.append(list);
  }
  function showProfile(){const d=openDialog('Профиль и настройки');const f=el('form');field(f,'Имя','name','text',root.auth.displayName,{required:true,maxlength:80});field(f,'Часовой пояс IANA','timeZone','text',root.data.settings.timeZone,{required:true});f.append(el('p',{class:'muted'},'Например: Asia/Yekaterinburg, Europe/Moscow. Даты операций не меняются.'));field(f,'Первый месяц учёта (можно сдвинуть назад)','firstMonth','month',root.data.settings.firstMonth,{required:true,min:'1900-01',max:root.data.settings.firstMonth});field(f,'Начальный остаток для нового первого месяца, ₽','amount','text',C.moneyInput(root.data.openingBalances[root.data.settings.firstMonth]),{required:true});f.append(el('h3',{},'Смена пароля — необязательно'));field(f,'Текущий пароль','current','password','',{autocomplete:'current-password',maxlength:128});field(f,'Новый пароль','password','password','',{autocomplete:'new-password',minlength:8,maxlength:128});field(f,'Повтор нового пароля','repeat','password','',{autocomplete:'new-password',minlength:8,maxlength:128});
    bindForm(f,async v=>{if(!v.name.trim())C.fail('Введите имя.','name');if(!C.validMonth(v.firstMonth)||v.firstMonth>root.data.settings.firstMonth)C.fail('Первый месяц можно сдвигать только назад.','firstMonth');let auth=null;if(v.password||v.repeat||v.current){if(!v.password||v.password.length<8)C.fail('Новый пароль — минимум 8 символов.','password');if(v.password!==v.repeat)C.fail('Пароли не совпадают.','repeat');if(!await CalendarAuth.verify(v.current,root.auth))C.fail('Неверный текущий пароль.','current');auth=await CalendarAuth.create(v.name.trim(),v.password);}const amount=C.money(v.amount,true);save(r=>{if(auth)r.auth=auth;else r.auth.displayName=v.name.trim();r.data.settings.timeZone=v.timeZone.trim();r.data.settings.firstMonth=v.firstMonth;r.data.openingBalances[v.firstMonth]=amount;});dateNow=C.today(root.data.settings.timeZone);modal.close();renderCalendar(false);});formActions(f);d.append(f);}
  function updateDayVisibility(){const table=document.querySelector('.calendar');if(!table)return;const count=C.days(viewMonth),cutoff=root.data.settings.hidePastDays&&viewMonth===dateNow.slice(0,7)?Number(dateNow.slice(8)):1;const cols=table.querySelectorAll('colgroup col');for(let day=1;day<=count;day++)cols[day].hidden=day<cutoff;for(const row of table.rows){if(row.cells.length===count+2){for(let day=1;day<=count;day++)row.cells[day].hidden=day<cutoff;}else{const spanning=row.querySelector('[colspan]');if(spanning)spanning.colSpan=count-cutoff+2;}}}
  function checkDate(){if(!session||!root||(drag&&drag.active))return;const value=C.today(root.data.settings.timeZone);if(value===dateNow)return;dateNow=value;const backupState=C.exportStatus(root),backupButton=document.querySelector('.backup-tools button'),backupLabel=document.querySelector('.backup-tools .save-state');if(backupButton)backupButton.classList.toggle('primary',backupState.due);if(backupLabel)backupLabel.textContent=backupState.label;updateDayVisibility();document.querySelectorAll('thead th[data-date]').forEach(n=>n.classList.toggle('today',n.dataset.date===value));document.querySelectorAll('.payment[data-planned]').forEach(n=>{const late=n.dataset.planned<value;n.classList.toggle('overdue',late);n.querySelector('.status').textContent=late?'Просрочено':'Запланировано';});}
  function timer(){clearInterval(dayTimer);if(!document.hidden)dayTimer=setInterval(checkDate,60000);}
  function boot(){try{probe();if(!globalThis.crypto||!crypto.subtle||!crypto.randomUUID){block('Web Crypto недоступен. Откройте файл в актуальном Chrome или Яндекс Браузере.');return;}raw=localStorage.getItem(C.KEY);root=raw?C.validateRoot(JSON.parse(raw)):null;cache.clear();conflict=false;renderAuth();}catch(e){block('Не удалось открыть локальное хранилище. '+e.message,raw);}}
  modal.addEventListener('close',()=>{if(!modal.open)modal.replaceChildren();});
  document.addEventListener('pointermove',pointerMove,{passive:false});document.addEventListener('pointerup',pointerUp);
  document.addEventListener('pointercancel',cancelDrag);document.addEventListener('keydown',e=>{if(e.key==='Escape'&&drag){e.preventDefault();cancelDrag();checkDate();}});
  document.addEventListener('click',e=>{if(performance.now()<suppressClickUntil){e.preventDefault();e.stopImmediatePropagation();}},true);
  window.addEventListener('storage',e=>{if(e.key===C.KEY)detectExternal();});window.addEventListener('focus',()=>{detectExternal();checkDate();});document.addEventListener('visibilitychange',()=>{timer();if(!document.hidden){detectExternal();checkDate();}});timer();boot();
})();
