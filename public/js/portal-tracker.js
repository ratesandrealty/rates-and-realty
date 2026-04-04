(function(){
'use strict';
var bid = localStorage.getItem('borrower_id') || localStorage.getItem('rr_borrower_id');
var puid = localStorage.getItem('portal_user_id');
var cid = localStorage.getItem('contact_id');
if (!bid && !puid) return;

var sid = sessionStorage.getItem('rr_session_id');
if (!sid) { sid = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); sessionStorage.setItem('rr_session_id', sid); }

var page = window.location.pathname + window.location.search;
var pageTitle = document.title || page;
var referrer = document.referrer || '';
var deviceType = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
var urlParams = new URLSearchParams(window.location.search);
var listingId = urlParams.get('listing_id') || urlParams.get('listing_key') || null;
var searchQuery = page.indexOf('search') >= 0 && urlParams.toString() ? Object.fromEntries(urlParams.entries()) : null;

var pvId = null, startTime = Date.now(), maxScroll = 0, exited = false;

window.addEventListener('scroll', function() {
  var pct = Math.round((window.scrollY / Math.max(1, document.body.scrollHeight - window.innerHeight)) * 100);
  if (pct > maxScroll) maxScroll = Math.min(pct, 100);
}, { passive: true });

function getAddr() {
  var el = document.querySelector('.property-address, #propertyAddress, [data-address], .detail-address, h1');
  return el ? el.textContent.trim().substring(0, 120) : null;
}

function cfg() { return window.APP_CONFIG || {}; }

async function trackView() {
  var c = cfg(); if (!c.SUPABASE_URL) return;
  try {
    var res = await fetch(c.SUPABASE_URL + '/rest/v1/portal_page_views', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'apikey':c.SUPABASE_ANON_KEY, 'Authorization':'Bearer '+c.SUPABASE_ANON_KEY, 'Prefer':'return=representation' },
      body: JSON.stringify({
        portal_user_id: puid||null, contact_id: cid||null, borrower_id: bid||null,
        session_id: sid, page: page, page_title: pageTitle, referrer: referrer,
        listing_id: listingId, listing_address: listingId ? getAddr() : null,
        search_query: searchQuery, device_type: deviceType,
        duration_seconds: 0, scroll_depth: 0
      })
    });
    var data = await res.json();
    if (data && data[0] && data[0].id) pvId = data[0].id;
  } catch(e) {}
}

function updateView() {
  if (!pvId || exited) return; exited = true;
  var c = cfg(); if (!c.SUPABASE_URL) return;
  var dur = Math.round((Date.now() - startTime) / 1000);
  var blob = new Blob([JSON.stringify({ duration_seconds: dur, scroll_depth: maxScroll, exited_at: new Date().toISOString(), listing_address: listingId ? getAddr() : undefined })], { type: 'application/json' });
  navigator.sendBeacon(c.SUPABASE_URL + '/rest/v1/portal_page_views?id=eq.' + pvId + '&apikey=' + c.SUPABASE_ANON_KEY, blob);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', trackView);
else trackView();

window.addEventListener('pagehide', updateView);
window.addEventListener('beforeunload', updateView);
document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'hidden') updateView(); });

if (listingId) setTimeout(function() {
  if (!pvId) return;
  var addr = getAddr(); if (!addr) return;
  var c = cfg();
  fetch(c.SUPABASE_URL + '/rest/v1/portal_page_views?id=eq.' + pvId, {
    method: 'PATCH', headers: { 'Content-Type':'application/json', 'apikey':c.SUPABASE_ANON_KEY, 'Authorization':'Bearer '+c.SUPABASE_ANON_KEY, 'Prefer':'return=minimal' },
    body: JSON.stringify({ listing_address: addr })
  }).catch(function(){});
}, 3000);

window.rrTrackEvent = function(d) {
  if (!pvId) return; var c = cfg(); if (!c.SUPABASE_URL) return;
  fetch(c.SUPABASE_URL + '/rest/v1/portal_page_views?id=eq.' + pvId, {
    method: 'PATCH', headers: { 'Content-Type':'application/json', 'apikey':c.SUPABASE_ANON_KEY, 'Authorization':'Bearer '+c.SUPABASE_ANON_KEY, 'Prefer':'return=minimal' },
    body: JSON.stringify(d)
  }).catch(function(){});
};
})();
