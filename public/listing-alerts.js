// Listing Alerts Module — used by portal + CRM contact page
const LA = window.ListingAlerts = {
  SB: 'https://ljywhvbmsibwnssxpesh.supabase.co',
  SK: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqeXdodmJtc2lid25zc3hwZXNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM2MjgzNDIsImV4cCI6MjA1OTIwNDM0Mn0.JEMDMlSo1OSmOLJnnqP3wZq0GFjDfMqcHEHGY-rVfI4',
  COUNTIES: {'Orange County':['Westminster','Garden Grove','Huntington Beach','Anaheim','Santa Ana','Irvine','Fountain Valley','Costa Mesa','Fullerton','Buena Park','Cypress','La Habra','Placentia','Brea','Yorba Linda','Orange','Tustin','Lake Forest','Mission Viejo','Laguna Niguel','Newport Beach','Dana Point','Aliso Viejo'],'Los Angeles County':['Long Beach','Los Angeles','Torrance','Compton','Inglewood','Hawthorne','Carson','El Monte','West Covina','Pomona','Norwalk','Burbank','Pasadena','Whittier','Downey','Glendale','Alhambra','Cerritos','Bellflower'],'Riverside County':['Riverside','Moreno Valley','Corona','Temecula','Murrieta','Hemet','Perris','Indio','Palm Springs','Menifee','Beaumont','Lake Elsinore'],'San Bernardino County':['San Bernardino','Fontana','Rancho Cucamonga','Ontario','Victorville','Rialto','Colton','Chino','Redlands','Highland','Chino Hills','Upland']},

  async renderAlertsList(containerId, ctx) {
    var c = document.getElementById(containerId); if (!c) return;
    this._containerId = containerId; this._ctx = ctx;
    c.innerHTML = '<div style="color:#888;font-size:.85rem;padding:20px">Loading alerts...</div>';
    var q = this.SB + '/rest/v1/listing_alerts?order=created_at.desc';
    if (ctx.portal_user_id) q += '&portal_user_id=eq.' + ctx.portal_user_id;
    else if (ctx.contact_id) q += '&contact_id=eq.' + ctx.contact_id;
    try {
      var res = await fetch(q, {headers:{'apikey':this.SK,'Authorization':'Bearer '+this.SK}});
      var alerts = await res.json();
      if (!Array.isArray(alerts)) alerts = [];
      var ctxStr = JSON.stringify(ctx).replace(/"/g,'&quot;');
      var btn = '<button onclick="ListingAlerts.showBuilder(\''+containerId+'\','+ctxStr+')" style="display:flex;align-items:center;gap:7px;background:#C9A84C;color:#000;border:none;border-radius:9px;padding:10px 18px;font-weight:700;font-size:.85rem;cursor:pointer;margin-bottom:16px"><i class="fas fa-plus"></i> Create New Alert</button>';
      if (!alerts.length) {
        c.innerHTML = btn + '<div style="text-align:center;padding:32px;background:#1a1a1a;border:1px solid #222;border-radius:10px;color:#555"><i class="fas fa-bell-slash" style="font-size:2rem;display:block;margin-bottom:10px"></i><div style="font-size:.88rem">No listing alerts yet.</div><div style="font-size:.75rem;margin-top:4px">Create one to get notified of new listings.</div></div>';
        return;
      }
      c.innerHTML = btn + alerts.map(function(a) { return LA.alertCard(a, ctx); }).join('');
    } catch(e) { c.innerHTML = '<div style="color:#e55;font-size:.85rem;padding:20px">Error loading alerts.</div>'; }
  },

  alertCard(a, ctx) {
    var cities = (a.cities||[]).slice(0,3).join(', ') + ((a.cities||[]).length > 3 ? ' +'+((a.cities||[]).length-3) : '');
    var freq = {instant:'Instant',daily:'Daily',weekly:'Weekly'}[a.frequency] || a.frequency || 'Daily';
    var pr = (a.min_price || a.max_price) ? '$'+(a.min_price?(a.min_price/1000).toFixed(0)+'K':'0')+' – '+(a.max_price?'$'+(a.max_price/1000).toFixed(0)+'K':'Any') : 'Any Price';
    var ctxStr = JSON.stringify(ctx).replace(/"/g,'&quot;');
    return '<div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:14px;margin-bottom:10px"><div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px"><div style="flex:1"><div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="font-weight:700;font-size:.92rem;color:#eee">'+(a.name||'Alert')+'</span><span style="background:'+(a.is_active?'rgba(0,160,80,.2)':'rgba(100,100,100,.2)')+';color:'+(a.is_active?'#3cb43c':'#888')+';border-radius:12px;padding:2px 8px;font-size:.68rem;font-weight:700">'+(a.is_active?'Active':'Paused')+'</span><span style="background:rgba(201,168,76,.15);color:#C9A84C;border-radius:12px;padding:2px 8px;font-size:.68rem;font-weight:600">'+freq+'</span></div><div style="font-size:.75rem;color:#888;line-height:1.7">'+(cities?'📍 '+cities+' · ':'')+'💰 '+pr+(a.min_beds?' · 🛏 '+a.min_beds+'+ beds':'')+((a.property_types||[]).length?' · 🏠 '+a.property_types.join(', '):'')+'</div></div><div style="display:flex;gap:6px;flex-shrink:0"><button onclick="ListingAlerts.toggleAlert(\''+a.id+'\','+(a.is_active?'false':'true')+')" style="background:#111;border:1px solid '+(a.is_active?'#e55':'#3cb43c')+';color:'+(a.is_active?'#e55':'#3cb43c')+';border-radius:7px;padding:6px 10px;font-size:.72rem;cursor:pointer"><i class="fas fa-'+(a.is_active?'pause':'play')+'"></i></button><button onclick="ListingAlerts.deleteAlert(\''+a.id+'\')" style="background:#111;border:1px solid #333;color:#666;border-radius:7px;padding:6px 10px;font-size:.72rem;cursor:pointer"><i class="fas fa-trash"></i></button></div></div><div style="font-size:.7rem;color:#555">'+(a.last_sent_at?'Last sent: '+new Date(a.last_sent_at).toLocaleDateString():'Never sent')+' · Total: '+(a.total_sent||0)+'</div></div>';
  },

  showBuilder(containerId, ctx, editId) {
    this._containerId = containerId; this._ctx = ctx;
    document.getElementById('laModal')?.remove();
    var m = document.createElement('div'); m.id = 'laModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:900;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto';
    var counties = Object.keys(this.COUNTIES);
    m.innerHTML = '<div style="background:#151515;border:1px solid #2a2a2a;border-radius:16px;width:100%;max-width:640px;max-height:95vh;overflow-y:auto"><div style="padding:18px 22px;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#151515;z-index:2"><h2 style="font-size:1rem;font-weight:700;color:#eee"><i class="fas fa-bell" style="color:#C9A84C;margin-right:8px"></i>'+(editId?'Edit':'Create')+' Alert</h2><button onclick="document.getElementById(\'laModal\').remove()" style="background:#1a1a1a;border:1px solid #333;border-radius:50%;width:30px;height:30px;color:#888;cursor:pointer">✕</button></div><div style="padding:20px 22px;display:flex;flex-direction:column;gap:16px"><div style="display:grid;grid-template-columns:1fr 1fr;gap:14px"><div><label style="font-size:.73rem;color:#888;display:block;margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Alert Name *</label><input id="laName" placeholder="e.g. Westminster 3bd under $800K" style="width:100%;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:10px 12px;color:#eee;font-size:.88rem;outline:none"></div><div><label style="font-size:.73rem;color:#888;display:block;margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Frequency</label><select id="laFreq" style="width:100%;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:10px 12px;color:#eee;font-size:.88rem;outline:none"><option value="instant">Instant</option><option value="daily" selected>Daily</option><option value="weekly">Weekly</option></select></div></div><div><label style="font-size:.73rem;color:#888;display:block;margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">County</label><select id="laCounty" onchange="ListingAlerts.renderCityChecks()" style="width:100%;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:10px 12px;color:#eee;font-size:.88rem;outline:none">'+counties.map(function(c){return'<option value="'+c+'">'+c+'</option>';}).join('')+'</select></div><div><label style="font-size:.73rem;color:#888;display:block;margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Cities</label><div id="laCityChecks" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:12px;max-height:180px;overflow-y:auto"></div></div><div><label style="font-size:.73rem;color:#888;display:block;margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Price Range</label><div style="display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center"><input type="number" id="laMinPrice" placeholder="Min $" step="25000" style="width:100%;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:10px;color:#eee;font-size:.85rem;outline:none"><span style="color:#555">—</span><input type="number" id="laMaxPrice" placeholder="Max $" step="25000" style="width:100%;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:10px;color:#eee;font-size:.85rem;outline:none"></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:14px"><div><label style="font-size:.73rem;color:#888;display:block;margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Min Beds</label><select id="laBeds" style="width:100%;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:9px;color:#eee;font-size:.85rem;outline:none"><option value="">Any</option><option value="1">1+</option><option value="2">2+</option><option value="3">3+</option><option value="4">4+</option><option value="5">5+</option></select></div><div><label style="font-size:.73rem;color:#888;display:block;margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Min Baths</label><select id="laBaths" style="width:100%;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:9px;color:#eee;font-size:.85rem;outline:none"><option value="">Any</option><option value="1">1+</option><option value="2">2+</option><option value="3">3+</option><option value="4">4+</option></select></div></div><button onclick="ListingAlerts.saveAlert(\''+(editId||'')+'\')" style="width:100%;background:#C9A84C;color:#000;border:none;border-radius:9px;padding:12px;font-weight:700;font-size:.9rem;cursor:pointer" id="laSaveBtn"><i class="fas fa-bell"></i> '+(editId?'Update':'Create')+' Alert</button></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click',function(e){if(e.target===m)m.remove();});
    this.renderCityChecks();
    if (editId) this.loadAlertForEdit(editId);
  },

  renderCityChecks() {
    var county = document.getElementById('laCounty')?.value || 'Orange County';
    var cities = this.COUNTIES[county] || [];
    var c = document.getElementById('laCityChecks'); if (!c) return;
    c.innerHTML = cities.map(function(city){return'<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:.78rem;color:#ccc;padding:3px 0"><input type="checkbox" value="'+city+'" class="la-city-cb" style="accent-color:#C9A84C;width:14px;height:14px;cursor:pointer"> '+city+'</label>';}).join('');
  },

  getFormData() {
    var selectedCities = [];
    document.querySelectorAll('.la-city-cb:checked').forEach(function(cb){selectedCities.push(cb.value);});
    return {
      name: document.getElementById('laName')?.value?.trim() || 'My Alert',
      frequency: document.getElementById('laFreq')?.value || 'daily',
      county: document.getElementById('laCounty')?.value || 'Orange County',
      cities: selectedCities,
      min_price: document.getElementById('laMinPrice')?.value ? Number(document.getElementById('laMinPrice').value) : null,
      max_price: document.getElementById('laMaxPrice')?.value ? Number(document.getElementById('laMaxPrice').value) : null,
      min_beds: document.getElementById('laBeds')?.value ? Number(document.getElementById('laBeds').value) : null,
      min_baths: document.getElementById('laBaths')?.value ? Number(document.getElementById('laBaths').value) : null,
    };
  },

  async saveAlert(editId) {
    var btn = document.getElementById('laSaveBtn');
    if (btn) {btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Saving...';}
    var data = Object.assign({}, this.getFormData(), this._ctx, {is_active:true});
    if (editId) {
      await fetch(this.SB+'/rest/v1/listing_alerts?id=eq.'+editId, {method:'PATCH',headers:{'Content-Type':'application/json','apikey':this.SK,'Authorization':'Bearer '+this.SK},body:JSON.stringify(data)});
    } else {
      await fetch(this.SB+'/rest/v1/listing_alerts', {method:'POST',headers:{'Content-Type':'application/json','apikey':this.SK,'Authorization':'Bearer '+this.SK,'Prefer':'return=representation'},body:JSON.stringify(data)});
    }
    document.getElementById('laModal')?.remove();
    await this.renderAlertsList(this._containerId, this._ctx);
    if (window.showToast) window.showToast(editId ? 'Alert updated!' : '✓ Alert created!');
  },

  async loadAlertForEdit(alertId) {
    var res = await fetch(this.SB+'/rest/v1/listing_alerts?id=eq.'+alertId, {headers:{'apikey':this.SK,'Authorization':'Bearer '+this.SK}});
    var arr = await res.json(); var a = arr[0]; if (!a) return;
    if (document.getElementById('laName')) document.getElementById('laName').value = a.name||'';
    if (document.getElementById('laFreq')) document.getElementById('laFreq').value = a.frequency||'daily';
    if (document.getElementById('laCounty')) {document.getElementById('laCounty').value = a.county||'Orange County'; this.renderCityChecks();}
    if (a.min_price) document.getElementById('laMinPrice').value = a.min_price;
    if (a.max_price) document.getElementById('laMaxPrice').value = a.max_price;
    if (a.min_beds) document.getElementById('laBeds').value = a.min_beds;
    if (a.min_baths) document.getElementById('laBaths').value = a.min_baths;
    setTimeout(function(){(a.cities||[]).forEach(function(city){document.querySelectorAll('.la-city-cb').forEach(function(cb){if(cb.value===city)cb.checked=true;});});},100);
  },

  async toggleAlert(alertId, newState) {
    await fetch(this.SB+'/rest/v1/listing_alerts?id=eq.'+alertId, {method:'PATCH',headers:{'Content-Type':'application/json','apikey':this.SK,'Authorization':'Bearer '+this.SK},body:JSON.stringify({is_active:newState==='true'||newState===true})});
    await this.renderAlertsList(this._containerId, this._ctx);
  },

  async deleteAlert(alertId) {
    if (!confirm('Delete this alert?')) return;
    await fetch(this.SB+'/rest/v1/listing_alerts?id=eq.'+alertId, {method:'DELETE',headers:{'apikey':this.SK,'Authorization':'Bearer '+this.SK}});
    await this.renderAlertsList(this._containerId, this._ctx);
  }
};
