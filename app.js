import {
  configured, auth, db,
  RecaptchaVerifier, signInWithPhoneNumber, onAuthStateChanged, signOut,
  doc, getDoc, updateDoc, collection, query, where, orderBy, limitToLast,
  onSnapshot, writeBatch, serverTimestamp, increment
} from './firebase.js';
import {
  COUNTRIES, COLORS, latin, esc, hm, dayLabel, listTime, seenLabel, initial, fmtFull, checkNumber, pad
} from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const wide = () => window.matchMedia('(min-width:881px)').matches;
const isTouch = () => window.matchMedia('(pointer:coarse)').matches;

/* ---------- state ---------- */
const S = {
  uid: null, phone: '', me: null,
  chats: new Map(),            // chatId -> chat document
  people: new Map(),           // uid -> user document (live)
  peopleUnsubs: new Map(),
  activeId: null, activeOther: null,
  draft: null,                 // محادثة جديدة لم تُرسل فيها رسالة بعد: {id, other}
  msgs: [],
  unsubChats: null, unsubMsgs: null,
  hb: null, clock: null, autoOpened: false
};
const A = { country: 0, full: '', color: COLORS[0], timer: null, left: 0 };
let verifier = null;
let confirmation = null;
let verifying = false;

/* ---------- views + small UI helpers ---------- */
function view(name) {
  ['loading', 'auth', 'app', 'setup'].forEach(v => { $('#' + v).hidden = v !== name; });
  $('#root').classList.toggle('is-app', name === 'app');
}
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}
function busy(btn, on) {
  btn.setAttribute('aria-busy', String(on));
  if (!btn.matches('#resend')) btn.disabled = on;
}
const AUTH_ERR = {
  'auth/invalid-phone-number': 'رقم الجوال غير صالح. راجع الرقم والدولة.',
  'auth/missing-phone-number': 'اكتب رقم الجوال.',
  'auth/too-many-requests': 'محاولات كثيرة. انتظر قليلاً ثم حاول من جديد.',
  'auth/quota-exceeded': 'تم تجاوز حد الرسائل النصية لهذا المشروع. حاول لاحقاً.',
  'auth/captcha-check-failed': 'فشل التحقق الأمني. أعد تحميل الصفحة وحاول مرة ثانية.',
  'auth/invalid-verification-code': 'الرمز غير صحيح. راجع الرسالة وحاول مرة ثانية.',
  'auth/code-expired': 'انتهت صلاحية الرمز. اطلب رمزاً جديداً.',
  'auth/network-request-failed': 'تعذر الاتصال بالإنترنت. تحقق من الشبكة.',
  'auth/operation-not-allowed': 'الدخول برقم الجوال غير مفعّل، أو دولتك غير مسموحة في إعدادات Firebase.',
  'auth/billing-not-enabled': 'إرسال الرسائل النصية يحتاج تفعيل الفوترة في مشروع Firebase.',
  'auth/unauthorized-domain': 'هذا النطاق غير مضاف إلى النطاقات المصرّح بها في Firebase Authentication.'
};
function authError(err) {
  console.error(err);
  return AUTH_ERR[err && err.code] || 'حدث خطأ غير متوقع. حاول مرة ثانية.';
}

/* ---------- phone fields ---------- */
function fillCountries(sel, index) {
  sel.innerHTML = COUNTRIES.map((c, i) => '<option value="' + i + '">' + esc(c.n) + ' (+' + c.c + ')</option>').join('');
  sel.value = String(index || 0);
}
function bindPhone(sel, pre, inp) {
  const sync = () => {
    const c = COUNTRIES[+sel.value];
    pre.textContent = '+' + c.c;
    inp.placeholder = 'X'.repeat(c.max).replace(/(X{3})(?=X)/g, '$1 ');
  };
  sel.addEventListener('change', sync);
  inp.addEventListener('input', () => {
    const v = latin(inp.value).replace(/[^\d\s]/g, '');
    if (v !== inp.value) inp.value = v;
  });
  sync();
}
fillCountries($('#country'), 0);
bindPhone($('#country'), $('#pre'), $('#phone'));
fillCountries($('#nCountry'), 0);
bindPhone($('#nCountry'), $('#nPre'), $('#nPhone'));

/* =====================================================================
   1) تسجيل الدخول برقم الجوال
   ===================================================================== */
function go(n) {
  ['s1', 's2', 's3'].forEach((id, i) => { $('#' + id).hidden = (i + 1) !== n; });
  $$('#steps .seg').forEach((s, i) => { s.classList.toggle('on', i < n); s.classList.toggle('cur', i === n - 1); });
  const first = n === 1 ? $('#phone') : n === 2 ? $('#otp input') : $('#pName');
  setTimeout(() => { try { first.focus(); } catch (e) { /* ignore */ } }, 30);
}

function makeVerifier() {
  if (verifier) { try { verifier.clear(); } catch (e) { /* ignore */ } }
  $('#recaptchaHolder').innerHTML = '<div id="recaptcha"></div>';
  verifier = new RecaptchaVerifier(auth, 'recaptcha', { size: 'invisible' });
  return verifier;
}

function paintResend() {
  const b = $('#resend');
  if (A.left > 0) { b.disabled = true; b.textContent = 'إعادة الإرسال بعد 0:' + pad(A.left); }
  else { b.disabled = false; b.textContent = 'إعادة إرسال الرمز'; }
}
function startTimer() {
  clearInterval(A.timer);
  A.left = 30; paintResend();
  A.timer = setInterval(() => { A.left--; paintResend(); if (A.left <= 0) clearInterval(A.timer); }, 1000);
}

async function sendCode(fromResend) {
  const btn = fromResend ? $('#resend') : $('#s1 button[type=submit]');
  $('#e1').textContent = ''; $('#e2').textContent = '';
  busy(btn, true);
  try {
    confirmation = await signInWithPhoneNumber(auth, '+' + A.full, makeVerifier());
    $('#sentTo').textContent = fmtFull(A.full);
    clearOtp(); startTimer(); go(2);
  } catch (err) {
    (fromResend ? $('#e2') : $('#e1')).textContent = authError(err);
  } finally {
    busy(btn, false);
    if (fromResend) paintResend();
  }
}

$('#s1').addEventListener('submit', e => {
  e.preventDefault();
  const idx = +$('#country').value;
  const r = checkNumber(COUNTRIES[idx], $('#phone').value);
  $('#e1').textContent = r.ok ? '' : r.error;
  if (!r.ok) return;
  A.country = idx; A.full = r.full;
  sendCode(false);
});
$('#editNum').addEventListener('click', () => { clearInterval(A.timer); go(1); });
$('#resend').addEventListener('click', () => sendCode(true));

const otp = $$('#otp input');
const otpValue = () => otp.map(i => i.value).join('');
function clearOtp() { otp.forEach(i => { i.value = ''; }); $('#otp').classList.remove('bad'); }

async function verifyCode() {
  if (verifying) return;
  const v = otpValue();
  if (v.length < 6) { $('#e2').textContent = 'اكتب الرمز كاملاً، 6 أرقام.'; return; }
  if (!confirmation) { $('#e2').textContent = 'اطلب رمزاً جديداً أولاً.'; return; }
  const btn = $('#s2 button[type=submit]');
  verifying = true; $('#e2').textContent = ''; busy(btn, true);
  try {
    await confirmation.confirm(v);
    // عند النجاح يتولى onAuthStateChanged نقل المستخدم للشاشة التالية
  } catch (err) {
    $('#e2').textContent = authError(err);
    const box = $('#otp');
    box.classList.add('bad'); box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
    setTimeout(() => { otp.forEach(i => { i.value = ''; }); otp[0].focus(); }, 450);
  } finally {
    verifying = false; busy(btn, false);
  }
}
otp.forEach((el, i) => {
  el.addEventListener('input', () => {
    const v = latin(el.value).replace(/\D/g, '');
    el.value = v.slice(-1);
    $('#otp').classList.remove('bad');
    if (v && i < 5) otp[i + 1].focus();
    if (otpValue().length === 6) verifyCode();
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !el.value && i > 0) { otp[i - 1].focus(); otp[i - 1].value = ''; }
    else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); otp[i - 1].focus(); }
    else if (e.key === 'ArrowRight' && i < 5) { e.preventDefault(); otp[i + 1].focus(); }
  });
  el.addEventListener('focus', () => el.select());
  el.addEventListener('paste', e => {
    e.preventDefault();
    const t = latin((e.clipboardData || window.clipboardData).getData('text')).replace(/\D/g, '').slice(0, 6);
    t.split('').forEach((ch, k) => { otp[k].value = ch; });
    otp[Math.min(t.length, 5)].focus();
    if (t.length === 6) verifyCode();
  });
});
$('#s2').addEventListener('submit', e => { e.preventDefault(); verifyCode(); });

/* الملف الشخصي (للحسابات الجديدة فقط) */
const sw = $('#swatches');
sw.innerHTML = COLORS.map(c =>
  '<button type="button" class="sw" style="--c:' + c + '" data-c="' + c + '" aria-label="لون" aria-pressed="' + (c === A.color) + '"></button>').join('');
function paintProfile() {
  const pa = $('#pAvatar');
  pa.style.setProperty('--c', A.color);
  pa.textContent = initial($('#pName').value);
  $$('.sw', sw).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.c === A.color)));
}
sw.addEventListener('click', e => { const b = e.target.closest('.sw'); if (!b) return; A.color = b.dataset.c; paintProfile(); });
$('#pName').addEventListener('input', paintProfile);
$('#notMe').addEventListener('click', () => signOut(auth));

$('#s3').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#pName').value.trim();
  if (name.length < 2) { $('#e3').textContent = 'اكتب اسماً من حرفين على الأقل.'; return; }
  $('#e3').textContent = '';
  const btn = $('#s3 button[type=submit]');
  busy(btn, true);
  try {
    const uid = S.uid;
    const userRef = doc(db, 'users', uid);
    const batch = writeBatch(db);
    batch.set(userRef, {
      name, phone: S.phone, color: A.color, status: $('#pStatus').value.trim(),
      createdAt: serverTimestamp(), lastSeen: serverTimestamp()
    });
    batch.set(doc(db, 'phones', S.phone), { uid }); // فهرس للبحث عن الأصدقاء بالرقم
    await batch.commit();
    const snap = await getDoc(userRef);
    S.me = snap.data();
    startApp();
  } catch (err) {
    console.error(err);
    $('#e3').textContent = 'تعذر حفظ الملف الشخصي. تأكد من نشر قواعد Firestore ثم حاول مرة ثانية.';
  } finally { busy(btn, false); }
});

/* حالة الدخول: المصدر الوحيد لتحديد الشاشة */
function bootAuth() {
  onAuthStateChanged(auth, async user => {
    if (!user) {
      teardown();
      S.uid = null; S.me = null;
      confirmation = null;
      $('#phone').value = ''; $('#pName').value = ''; $('#pStatus').value = '';
      A.color = COLORS[0]; paintProfile(); clearOtp();
      view('auth'); go(1);
      return;
    }
    S.uid = user.uid;
    S.phone = (user.phoneNumber || '').replace('+', '');
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists()) { S.me = snap.data(); startApp(); }
      else { clearInterval(A.timer); view('auth'); go(3); paintProfile(); }
    } catch (err) {
      console.error(err);
      view('auth'); go(1);
      $('#e1').textContent = 'تعذر الاتصال بقاعدة البيانات. تأكد من إنشاء Firestore ونشر القواعد.';
    }
  });
}

/* =====================================================================
   2) المحادثات
   ===================================================================== */
const otherOf = c => c.members.find(x => x !== S.uid);
const person = uid => S.people.get(uid) || null;
const personName = uid => (person(uid) && person(uid).name) || '…';
const personColor = uid => (person(uid) && person(uid).color) || COLORS[4];
const millis = ts => (ts && ts.toMillis ? ts.toMillis() : 0);
const isOnline = p => !!(p && p.lastSeen && Date.now() - millis(p.lastSeen) < 100000);
const chatIdFor = (a, b) => [a, b].sort().join('_');

function ensurePerson(uid) {
  if (!uid || S.peopleUnsubs.has(uid)) return;
  const unsub = onSnapshot(doc(db, 'users', uid), snap => {
    S.people.set(uid, snap.exists() ? snap.data({ serverTimestamps: 'estimate' }) : null);
    renderList();
    if (S.activeOther === uid) renderThread();
  }, err => console.error(err));
  S.peopleUnsubs.set(uid, unsub);
}

function icon(kind) {
  const base = ' class="tick' + (kind === 'read' ? ' read' : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  if (kind === 'pending') return '<svg' + base + ' aria-label="جارٍ الإرسال"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>';
  if (kind === 'sent') return '<svg' + base + ' aria-label="أُرسلت"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
  return '<svg' + base + ' aria-label="قُرئت"><path d="M2 12.5l4.5 4.5L15 8.5"/><path d="M9.5 15.5 11 17 21 7"/></svg>';
}

function renderMe() {
  const a = $('#meAv');
  a.style.setProperty('--c', S.me.color);
  a.textContent = initial(S.me.name);
}

function items() {
  const arr = [...S.chats.values()].map(c => ({ id: c.id, other: otherOf(c), chat: c, ts: millis(c.lastTs) }));
  if (S.draft && !S.chats.has(S.draft.id)) arr.push({ id: S.draft.id, other: S.draft.other, chat: null, ts: Date.now() });
  return arr.sort((a, b) => b.ts - a.ts);
}

function renderList() {
  if (!S.uid) return;
  const q = latin($('#q').value).trim().toLowerCase();
  const qd = q.replace(/\D/g, '');
  const list = items().filter(it => {
    if (!q) return true;
    const p = person(it.other);
    const last = it.chat && it.chat.lastMessage ? String(it.chat.lastMessage.text).toLowerCase() : '';
    return (p && String(p.name).toLowerCase().includes(q)) || (qd && p && p.phone && p.phone.includes(qd)) || last.includes(q);
  });
  const ul = $('#chats');
  if (!list.length) {
    ul.innerHTML = '<li class="no-res">' + (q ? 'لا توجد نتائج لهذا البحث.' : 'لا توجد محادثات بعد. اضغط + وابدأ بإضافة رقم صديق.') + '</li>';
    return;
  }
  ul.innerHTML = list.map(it => {
    const p = person(it.other), c = it.chat;
    const lm = c && c.lastMessage;
    let prev = '<span class="tx">ابدأ المحادثة</span>';
    if (lm) {
      let t = '';
      if (lm.from === S.uid) {
        const r = c.reads && c.reads[it.other];
        t = c._pending ? icon('pending') : (r && millis(r) >= millis(c.lastTs) ? icon('read') : icon('sent'));
      }
      prev = t + '<span class="tx">' + esc(lm.text) + '</span>';
    }
    const unread = (c && c.unread && c.unread[S.uid]) || 0;
    return '<li><button class="row" type="button" data-id="' + esc(it.id) + '" data-other="' + esc(it.other) + '" aria-current="' + (it.id === S.activeId) + '">'
      + '<span class="avatar' + (isOnline(p) ? ' on' : '') + '" style="--c:' + personColor(it.other) + '">' + esc(initial(personName(it.other))) + '</span>'
      + '<span class="mid"><span class="name">' + esc(personName(it.other)) + '</span><span class="prev">' + prev + '</span></span>'
      + '<span class="end"><span class="time">' + (c && c.lastTs ? listTime(millis(c.lastTs)) : '') + '</span>'
      + (unread ? '<span class="badge">' + unread + '</span>' : '') + '</span>'
      + '</button></li>';
  }).join('');
}

function renderThread(force) {
  const th = $('#thread'), em = $('#empty');
  if (!S.activeId) { th.hidden = true; em.hidden = false; return; }
  em.hidden = true; th.hidden = false;
  const o = S.activeOther, p = person(o);
  const av = $('#cAv');
  av.style.setProperty('--c', personColor(o)); av.textContent = initial(personName(o)); av.classList.toggle('on', isOnline(p));
  $('#cName').textContent = personName(o);
  const st = $('#cSt');
  st.className = 'st';
  if (isOnline(p)) { st.textContent = 'متصل الآن'; st.classList.add('on'); }
  else if (p && p.lastSeen) st.textContent = seenLabel(millis(p.lastSeen));
  else st.textContent = p && p.phone ? fmtFull(p.phone) : '';

  const chat = S.chats.get(S.activeId);
  const theirRead = chat && chat.reads && chat.reads[o] ? millis(chat.reads[o]) : 0;
  const box = $('#msgs');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  let html = '', prevFrom = null, lastDay = null;
  S.msgs.forEach(m => {
    const ts = millis(m.createdAt) || Date.now();
    const dl = dayLabel(ts);
    if (dl !== lastDay) { html += '<div class="day">' + esc(dl) + '</div>'; lastDay = dl; prevFrom = null; }
    const mine = m.from === S.uid;
    let t = '';
    if (mine) t = m.pending ? icon('pending') : (theirRead && theirRead >= ts ? icon('read') : icon('sent'));
    html += '<div class="bubble ' + (mine ? 'me' : 'them') + (prevFrom !== m.from ? ' first' : '') + '"><div class="t">' + esc(m.text) + '</div>'
      + '<div class="meta"><span>' + hm(ts) + '</span>' + t + '</div></div>';
    prevFrom = m.from;
  });
  box.innerHTML = html;
  if (near || force) box.scrollTop = box.scrollHeight;
}

function updateTitle() {
  let n = 0;
  S.chats.forEach(c => { n += (c.unread && c.unread[S.uid]) || 0; });
  document.title = (n ? '(' + n + ') ' : '') + 'ونسة';
}

function openChat(id, other) {
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  S.activeId = id; S.activeOther = other; S.msgs = [];
  ensurePerson(other);
  $('#app').classList.add('show-conv');
  renderList(); renderThread(true);
  S.unsubMsgs = onSnapshot(
    query(collection(db, 'chats', id, 'messages'), orderBy('createdAt', 'asc'), limitToLast(300)),
    snap => {
      if (S.activeId !== id) return;
      S.msgs = snap.docs.map(d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: 'estimate' }) }));
      renderThread(); markRead();
    },
    err => { console.error(err); toast('تعذر تحميل الرسائل.'); }
  );
  markRead();
  if (wide()) setTimeout(() => $('#ta').focus(), 30);
}
function closeChat() {
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  S.activeId = null; S.activeOther = null; S.msgs = [];
  $('#app').classList.remove('show-conv');
  renderList(); renderThread();
}

/** يصفّر عدّاد غير المقروء ويسجّل وقت القراءة (تظهر علامتا القراءة عند الطرف الآخر) */
function markRead() {
  const id = S.activeId;
  if (!id || document.hidden) return;
  const c = S.chats.get(id);
  if (!c) return;
  const unread = (c.unread && c.unread[S.uid]) || 0;
  if (unread <= 0) return;
  updateDoc(doc(db, 'chats', id), {
    ['unread.' + S.uid]: 0,
    ['reads.' + S.uid]: serverTimestamp()
  }).catch(err => console.error(err));
}

/* إرسال رسالة */
function commitSend(id, other, text, existing) {
  const chatRef = doc(db, 'chats', id);
  const msgRef = doc(collection(chatRef, 'messages'));
  const batch = writeBatch(db);
  const last = { text: text.slice(0, 200), from: S.uid };
  batch.set(msgRef, { from: S.uid, text, createdAt: serverTimestamp() });
  if (existing) {
    batch.update(chatRef, {
      lastMessage: last, lastTs: serverTimestamp(),
      ['unread.' + other]: increment(1),
      ['reads.' + S.uid]: serverTimestamp()
    });
  } else {
    batch.set(chatRef, {
      members: [S.uid, other].sort(), createdAt: serverTimestamp(),
      lastMessage: last, lastTs: serverTimestamp(),
      unread: { [other]: 1, [S.uid]: 0 },
      reads: { [S.uid]: serverTimestamp() }
    });
  }
  return batch.commit();
}
async function send() {
  const ta = $('#ta'), text = ta.value.trim();
  if (!S.activeId || !text) return;
  const id = S.activeId, other = S.activeOther;
  ta.value = ''; autosize();
  let existing = S.chats.has(id);
  if (!existing) {
    try { existing = (await getDoc(doc(db, 'chats', id))).exists(); } catch (e) { /* نجرّب الإنشاء */ }
  }
  commitSend(id, other, text, existing).catch(async err => {
    if (!existing && err && err.code === 'permission-denied') {
      try { await commitSend(id, other, text, true); return; } catch (e2) { err = e2; }
    }
    console.error(err);
    toast('تعذر إرسال الرسالة. تحقق من الاتصال وقواعد Firestore.');
  });
}
function autosize() {
  const ta = $('#ta');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  $('#sendBtn').disabled = !ta.value.trim();
}
$('#ta').addEventListener('input', autosize);
$('#ta').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) { e.preventDefault(); send(); }
});
$('#composer').addEventListener('submit', e => { e.preventDefault(); send(); if (!isTouch()) $('#ta').focus(); });
$('#chats').addEventListener('click', e => {
  const b = e.target.closest('.row');
  if (b) openChat(b.dataset.id, b.dataset.other);
});
$('#backBtn').addEventListener('click', closeChat);
$('#q').addEventListener('input', renderList);

/* الحضور: آخر ظهور يُحدَّث كل دقيقة والتبويب ظاهر */
function beat() {
  if (document.hidden || !S.uid) return;
  updateDoc(doc(db, 'users', S.uid), { lastSeen: serverTimestamp() }).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.uid) { beat(); markRead(); } });

function startApp() {
  clearInterval(A.timer);
  view('app');
  renderMe();
  S.chats = new Map(); S.autoOpened = false;
  $('#q').value = '';
  beat();
  S.hb = setInterval(beat, 60000);
  S.clock = setInterval(() => { renderList(); renderThread(); }, 30000);
  S.unsubChats = onSnapshot(
    query(collection(db, 'chats'), where('members', 'array-contains', S.uid)),
    snap => {
      const m = new Map();
      snap.forEach(d => {
        const c = { id: d.id, _pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: 'estimate' }) };
        m.set(d.id, c);
        ensurePerson(otherOf(c));
      });
      S.chats = m;
      if (S.draft && m.has(S.draft.id)) S.draft = null;
      renderList(); if (S.activeId) renderThread();
      markRead(); updateTitle();
      if (!S.autoOpened) {
        S.autoOpened = true;
        if (wide() && !S.activeId) { const f = items()[0]; if (f) openChat(f.id, f.other); }
      }
    },
    err => { console.error(err); toast('تعذر تحميل المحادثات. تحقق من قواعد Firestore.'); }
  );
}

function teardown() {
  if (S.unsubChats) { S.unsubChats(); S.unsubChats = null; }
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  S.peopleUnsubs.forEach(u => u()); S.peopleUnsubs = new Map(); S.people = new Map();
  clearInterval(S.hb); clearInterval(S.clock);
  S.chats = new Map(); S.msgs = []; S.activeId = null; S.activeOther = null; S.draft = null;
  $('#app').classList.remove('show-conv');
  document.title = 'ونسة';
}

/* ---------- dialogs ---------- */
let lastFocus = null;
function openOv(el, focusSel) {
  lastFocus = document.activeElement;
  el.hidden = false;
  setTimeout(() => { const f = $(focusSel, el); if (f) f.focus(); }, 30);
}
function closeOv(el) {
  el.hidden = true;
  if (el.id === 'ovSet') resetLogout();
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
}
$$('.overlay').forEach(ov => {
  ov.addEventListener('mousedown', e => { if (e.target === ov) closeOv(ov); });
  $$('[data-close]', ov).forEach(b => b.addEventListener('click', () => closeOv(ov)));
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $$('.overlay').forEach(ov => { if (!ov.hidden) closeOv(ov); });
});

/* محادثة جديدة: نبحث عن الرقم في فهرس phones */
function openNew() {
  const idx = A.country || 0;
  $('#nCountry').value = String(idx);
  $('#nCountry').dispatchEvent(new Event('change'));
  $('#nPhone').value = ''; $('#eN').textContent = ''; $('#inviteBtn').hidden = true;
  openOv($('#ovNew'), '#nPhone');
}
$('#newBtn').addEventListener('click', openNew);
$('#newBtn2').addEventListener('click', openNew);
$('#newForm').addEventListener('submit', async e => {
  e.preventDefault();
  const r = checkNumber(COUNTRIES[+$('#nCountry').value], $('#nPhone').value);
  $('#inviteBtn').hidden = true;
  if (!r.ok) { $('#eN').textContent = r.error; return; }
  if (r.full === S.phone) { $('#eN').textContent = 'هذا رقمك أنت. أدخل رقم شخص آخر.'; return; }
  const btn = $('#newForm button[type=submit]');
  busy(btn, true); $('#eN').textContent = '';
  try {
    const snap = await getDoc(doc(db, 'phones', r.full));
    if (!snap.exists()) {
      $('#eN').textContent = 'هذا الرقم غير مسجّل في ونسة بعد. ادعُ صاحبه ليسجّل.';
      $('#inviteBtn').hidden = false;
      return;
    }
    const other = snap.data().uid;
    const id = chatIdFor(S.uid, other);
    ensurePerson(other);
    if (!S.chats.has(id)) S.draft = { id, other };
    closeOv($('#ovNew'));
    openChat(id, other);
    if (!wide()) setTimeout(() => $('#ta').focus(), 80);
  } catch (err) {
    console.error(err);
    $('#eN').textContent = 'تعذر البحث عن الرقم. تحقق من الاتصال وقواعد Firestore.';
  } finally { busy(btn, false); }
});
$('#inviteBtn').addEventListener('click', async () => {
  const text = 'سجّل في ونسة وابدأ الونسة معي: ' + location.origin;
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('تم نسخ رابط الدعوة.'); }
  } catch (e) { /* تجاهل إلغاء المشاركة */ }
});

/* الإعدادات */
$('#meBtn').addEventListener('click', () => {
  const sa = $('#sAv'); sa.style.setProperty('--c', S.me.color); sa.textContent = initial(S.me.name);
  $('#sPhone').textContent = fmtFull(S.phone);
  $('#sName').value = S.me.name; $('#sStatus').value = S.me.status || ''; $('#eS').textContent = '';
  resetLogout();
  openOv($('#ovSet'), '#sName');
});
$('#setForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#sName').value.trim();
  if (name.length < 2) { $('#eS').textContent = 'اكتب اسماً من حرفين على الأقل.'; return; }
  const btn = $('#setForm button[type=submit]');
  busy(btn, true);
  try {
    const status = $('#sStatus').value.trim();
    await updateDoc(doc(db, 'users', S.uid), { name, status });
    S.me = { ...S.me, name, status };
    renderMe(); closeOv($('#ovSet'));
  } catch (err) {
    console.error(err);
    $('#eS').textContent = 'تعذر حفظ التغييرات. حاول مرة ثانية.';
  } finally { busy(btn, false); }
});
let logoutArmed = false;
function resetLogout() { logoutArmed = false; $('#logoutBtn').textContent = 'تسجيل الخروج'; }
$('#logoutBtn').addEventListener('click', async () => {
  if (!logoutArmed) { logoutArmed = true; $('#logoutBtn').textContent = 'اضغط مرة ثانية لتأكيد الخروج'; return; }
  $('#ovSet').hidden = true; resetLogout();
  try { await signOut(auth); } catch (err) { console.error(err); toast('تعذر تسجيل الخروج.'); }
});

/* ---------- boot ---------- */
paintProfile();
if (!configured) view('setup');
else bootAuth();
