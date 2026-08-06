import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/require-staff.ts";
import { PDFDocument, rgb, StandardFonts, PDFName, PDFString, pushGraphicsState, popGraphicsState, moveTo, lineTo, appendBezierCurve, closePath, clip, endPath } from 'npm:pdf-lib@1.17.1';
import fontkit from 'npm:@pdf-lib/fontkit@1.1.1';
import { createClient } from 'jsr:@supabase/supabase-js@2';

// generate-cma — branded Comparative Market Analysis PDF (matches the pre-approval design).
// Page 1: branded summary (header, value gauge, metric cards, price chart, comps table, QR).
// Pages 2..n+1: one detail page per comparable (hero photo/placeholder, spec cards, vs-subject).
// include_acquisition + da_inputs -> appends the branded Deal-Analysis page(s) at the end.

const LOGO_PNG_B64 = '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';
const HEADSHOT_URL = 'https://raw.githubusercontent.com/ratesandrealty/rates-and-realty/main/assets/images/rene-headshot.png';
const QR_URL = 'https://raw.githubusercontent.com/ratesandrealty/rates-and-realty/main/assets/images/qr-code.png';
const GMAPS_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY')||Deno.env.get('GOOGLE_STATIC_MAPS_API_KEY')||Deno.env.get('GOOGLE_MAPS_STATIC_API_KEY')||Deno.env.get('GOOGLE_API_KEY')||Deno.env.get('GOOGLE_MAPS_KEY')||Deno.env.get('GOOGLE_PLACES_API_KEY')||'';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
};

const W=612,H=792,M=44,CW=W-M*2;
const GOLD=rgb(0.788,0.659,0.298), WHITE=rgb(1,1,1), DARK=rgb(0.08,0.08,0.08);
const GRAY=rgb(0.52,0.52,0.52), LGRAY=rgb(0.87,0.87,0.87), BGRAY=rgb(0.97,0.96,0.94);
const GREEN=rgb(0.086,0.60,0.22), BLUE=rgb(0.20,0.42,0.74), RED=rgb(0.72,0.21,0.18);
const SOLDBAR=rgb(0.17,0.45,0.30), ACTBAR=rgb(0.22,0.44,0.74), TRACK=rgb(0.90,0.89,0.86);

const san=(x:any)=>x==null?'':String(x).replace(/[\r\n\t]/g,' ').replace(/[\x00-\x1F\x7F]/g,'').replace(/\s+/g,' ').trim();
const vv=(x:any,fb='')=>san(x)||san(fb)||'';
const num=(x:any)=>{const f=parseFloat(String(x??''));return isNaN(f)?0:f;};
const fmt=(n:any,d=0)=>{const x=parseFloat(String(n??0));return isNaN(x)?'0':x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});};
const money=(n:any)=>n==null||isNaN(parseFloat(String(n)))?'—':'$'+fmt(n,0);
const moneyK=(n:any)=>{const x=parseFloat(String(n));return isNaN(x)?'—':'$'+(x/1000).toFixed(0)+'k';};
const dt=(s:any)=>{if(!s)return '—';const d=new Date(s);return isNaN(d.getTime())?'—':((d.getMonth()+1)+'/'+d.getDate()+'/'+String(d.getFullYear()).slice(2));};
const statusText=(s:any)=>{const v=String(s||'');if(/sold|closed|off-?market/i.test(v))return 'Sold / Off-market';if(/withdraw/i.test(v))return 'Withdrawn';if(/cancel/i.test(v))return 'Canceled';if(/pend/i.test(v))return 'Pending';if(/active|coming/i.test(v))return 'Active listing';return v||'Active listing';};
const statusShort=(s:any)=>{const v=String(s||'');if(/sold|closed|off-?market/i.test(v))return 'Sold';if(/withdraw/i.test(v))return 'Withdrawn';if(/cancel/i.test(v))return 'Canceled';if(/pend/i.test(v))return 'Pending';return 'Active';};

function u8b64(arr:Uint8Array){let b='';const ch=8192;for(let i=0;i<arr.length;i+=ch)b+=String.fromCharCode(...arr.subarray(i,i+ch));return btoa(b);}
function truncate(font:any,s:string,size:number,maxW:number){
  s=san(s);if(!s)return '';if(font.widthOfTextAtSize(s,size)<=maxW)return s;
  while(s.length>1&&font.widthOfTextAtSize(s+'…',size)>maxW)s=s.slice(0,-1);
  return s+'…';
}
function b64ToU8(b64:string){return Uint8Array.from(atob(b64),c=>c.charCodeAt(0));}
async function tryEmbedImage(doc:any, url:any){
  const u=san(url); if(!u||!/^https?:\/\//i.test(u)) return null;
  try{
    const r=await fetch(u); if(!r.ok) return null;
    const buf=new Uint8Array(await r.arrayBuffer()); if(buf.length<100) return null;
    if(buf[0]===0xFF&&buf[1]===0xD8) return await doc.embedJpg(buf);
    if(buf[0]===0x89&&buf[1]===0x50) return await doc.embedPng(buf);
    return null;
  }catch(_e){ return null; }
}

const RENTCAST_KEY = Deno.env.get('RENTCAST_API_KEY')||'';
function rentType(pt:any){ const v=String(pt||''); const ok=['Single Family','Condo','Townhouse','Manufactured','Multi-Family','Apartment','Land']; return ok.find(x=>x.toLowerCase()===v.toLowerCase())||''; }
async function fetchRentAVM(subj:any){
  if(!RENTCAST_KEY) return null;
  const addr=(subj&&subj.address?String(subj.address):'').trim(); if(!addr) return null;
  const qs=new URLSearchParams(); qs.set('address',addr);
  const pt=rentType(subj.propertyType); if(pt) qs.set('propertyType',pt);
  if(subj.bedrooms!=null&&subj.bedrooms!=='') qs.set('bedrooms',String(subj.bedrooms));
  if(subj.bathrooms!=null&&subj.bathrooms!=='') qs.set('bathrooms',String(subj.bathrooms));
  if(subj.squareFootage!=null&&subj.squareFootage!=='') qs.set('squareFootage',String(subj.squareFootage));
  qs.set('maxRadius','5'); qs.set('compCount','12');
  try{
    const r=await fetch('https://api.rentcast.io/v1/avm/rent/long-term?'+qs.toString(),{headers:{'X-Api-Key':RENTCAST_KEY,'Accept':'application/json'}});
    if(!r.ok) return null;
    const j=await r.json().catch(()=>null); if(!j) return null;
    const comps=(Array.isArray(j.comparables)?j.comparables:[]).map((c:any)=>({
      address:c.formattedAddress||[c.addressLine1,c.city,c.state,c.zipCode].filter(Boolean).join(', '),
      bedrooms:c.bedrooms??null, bathrooms:c.bathrooms??null, squareFootage:c.squareFootage??null,
      rent:c.price??null, distance:c.distance??null, daysOnMarket:c.daysOnMarket??null,
    }));
    return { estimate:j.rent??null, low:j.rentRangeLow??null, high:j.rentRangeHigh??null, comps };
  }catch(_e){ return null; }
}

// ---- Deal-Analyzer compute (mirrors exportDealAnalyzerPDF in lead-detail.html) ----
function computeDeal(inputs:any, borrowerName:string, propertyAddress:string){
  const I:any={};
  for(const k of ['purchase','reno','arv','hold_months','hold_monthly','lender_fees','buy_closing','sell_closing','realtor_pct','rent','vacancy_pct','opex_pct','loan_rate','loan_term','refi_ltv','bh_down_pct','appreciation_pct','flip_ltc_pct','flip_hm_rate','flip_points']) I[k]=num(inputs?.[k]);
  const holding=I.hold_months*I.hold_monthly;
  const realtorFee=I.arv*(I.realtor_pct/100);
  const effRent=I.rent*(1-I.vacancy_pct/100);
  const opexAmt=I.rent*(I.opex_pct/100);
  const noiAnnual=(effRent-opexAmt)*12;
  const capRate=I.purchase>0?noiAnnual/I.purchase*100:0;
  const _pi=(p:number,a:number,yrs:number)=>{if(!(p>0)||!(yrs>0))return 0;const n=yrs*12,r=(a/100)/12;if(r<=0)return p/n;const pw=Math.pow(1+r,n);return p*(r*pw)/(pw-1);};
  const ltcLoan=(I.purchase+I.reno)*(I.flip_ltc_pct/100);
  const pointsDollar=ltcLoan*(I.flip_points/100);
  const interestCarry=ltcLoan*(I.flip_hm_rate/100/12)*I.hold_months;
  const flipCost=I.purchase+I.reno+holding+I.buy_closing+I.sell_closing+realtorFee+I.lender_fees+pointsDollar+interestCarry;
  const cashToClose=(I.purchase+I.reno)-ltcLoan+I.buy_closing+I.lender_fees+pointsDollar;
  const flipProfit=I.arv-flipCost;
  const flipROI=cashToClose>0?(flipProfit/cashToClose)*100:0;
  const flipAnnROI=(cashToClose>0&&I.hold_months>0)?flipROI*(12/I.hold_months):flipROI;
  const profitMargin=I.arv>0?(flipProfit/I.arv)*100:0;
  const maxBuy=I.arv>0?(I.arv*0.70-I.reno):0;
  const rule70Pass=(I.purchase>0&&I.arv>0&&I.purchase<=maxBuy);
  const brrrrCost=I.purchase+I.reno+holding+I.lender_fees+I.buy_closing;
  const brrrrNewLoan=I.arv*(I.refi_ltv/100);
  const brrrrCashLeft=brrrrCost-brrrrNewLoan;
  const brrrrRefiPmt=_pi(brrrrNewLoan,I.loan_rate,I.loan_term);
  const brrrrCF=effRent-brrrrRefiPmt-opexAmt;
  const brrrrDscr=brrrrRefiPmt>0?noiAnnual/(brrrrRefiPmt*12):0;
  const brrrrCoC=brrrrCashLeft>0?(brrrrCF*12)/brrrrCashLeft*100:0;
  const bhDownPmt=I.purchase*(I.bh_down_pct/100);
  const bhLoan=I.purchase-bhDownPmt;
  const bhCashInvested=bhDownPmt+I.reno+holding+I.lender_fees+I.buy_closing;
  const bhPmt=_pi(bhLoan,I.loan_rate,I.loan_term);
  const bhCF=effRent-bhPmt-opexAmt;
  const bhDscr=bhPmt>0?noiAnnual/(bhPmt*12):0;
  const bhCoC=bhCashInvested>0?(bhCF*12)/bhCashInvested*100:0;
  const eqY1=I.arv>0?I.arv*Math.pow(1+I.appreciation_pct/100,1)-I.arv:0;
  const eqY5=I.arv>0?I.arv*Math.pow(1+I.appreciation_pct/100,5)-I.arv:0;
  const eqY10=I.arv>0?I.arv*Math.pow(1+I.appreciation_pct/100,10)-I.arv:0;
  return {
    borrower_name:borrowerName, property_address:propertyAddress, inputs:I,
    property:{noi_annual:noiAnnual,cap_rate:capRate,appreciation_pct:I.appreciation_pct,equity_y1:eqY1,equity_y5:eqY5,equity_y10:eqY10},
    results:{
      flip:{cash_needed:cashToClose,total_project_cost:flipCost,hm_loan:ltcLoan,hm_points_amt:pointsDollar,hm_interest_carry:interestCarry,gross_profit:flipProfit,roi:flipROI,annualized_roi:flipAnnROI,profit_margin:profitMargin,coc:flipAnnROI,max_buy:maxBuy,rule_70_pass:rule70Pass},
      brrrr:{cash_left:brrrrCashLeft,new_loan:brrrrNewLoan,refi_pmt:brrrrRefiPmt,cash_flow:brrrrCF,dscr:brrrrDscr,coc:brrrrCoC},
      buy_hold:{cash_invested:bhCashInvested,down_pmt:bhDownPmt,bh_pmt:bhPmt,cash_flow:bhCF,dscr:bhDscr,coc:bhCoC},
    },
  };
}

// ── SNAPSHOT MODE ── Freeze the current client CMA payload into a hosted /cma/<slug> page.
// Reuses fetchRentAVM (rentals), computeDeal (acquisition), and the same plain photo fetch the
// PDF path uses. Never throws into the PDF path — only runs when body.mode === 'snapshot'.
async function buildCMASnapshot(body:any){
  const jsonRes=(d:any,status=200)=>new Response(JSON.stringify(d),{status,headers:{...cors,'Content-Type':'application/json'}});
  try{
    const sb=createClient(SUPABASE_URL, SERVICE_KEY);
    const subject=body.subject||{};
    const contactId=body.contact_id||null;
    const includeRentals=!!body.include_rentals;
    const includeAcq=!!body.include_acquisition;
    const borrowerName=vv(body.borrower_name)||'Borrower';
    const propertyAddress=vv(body.property_address)||vv(subject.address)||'';

    // 1) Allocate a unique 7-char slug (gen_cma_slug), unique vs cma_snapshots AND short_links.
    let slug='';
    for(let i=0;i<12;i++){
      const {data:sd,error:se}=await sb.rpc('gen_cma_slug');
      if(se) throw new Error('slug generation failed: '+se.message);
      const cand=String(sd||'').trim(); if(!cand) continue;
      const {data:ex1}=await sb.from('cma_snapshots').select('id').eq('slug',cand).maybeSingle();
      const {data:ex2}=await sb.from('short_links').select('id').eq('slug',cand).maybeSingle();
      if(!ex1 && !ex2){ slug=cand; break; }
    }
    if(!slug) throw new Error('could not allocate a unique slug');

    // 2) Rental re-fetch (same call the PDF uses) → freeze {estimate, low, high, comps[]}.
    let rental:any=null;
    if(includeRentals){ try{ rental=await fetchRentAVM(subject); }catch(_e){ rental=null; } }

    // 3) Rehost comp photos (+ subject hero if present) to the public 'cma-photos' bucket, using
    //    the SAME plain GET the PDF uses (photoUrl is the public trestle-proxy URL — no auth).
    async function rehost(srcUrl:any, key:string):Promise<string|null>{
      const u=san(srcUrl); if(!u||!/^https?:\/\//i.test(u)) return null;
      try{
        const r=await fetch(u); if(!r.ok) return null;
        const bytes=new Uint8Array(await r.arrayBuffer()); if(bytes.length<100) return null;
        let ext='jpg', ct=r.headers.get('Content-Type')||'image/jpeg';
        if(bytes[0]===0x89&&bytes[1]===0x50){ ext='png'; ct='image/png'; }
        else if(bytes[0]===0xFF&&bytes[1]===0xD8){ ext='jpg'; ct='image/jpeg'; }
        const path=`${slug}/${key}.${ext}`;
        const {error:upErr}=await sb.storage.from('cma-photos').upload(path, new Blob([bytes],{type:ct}), {contentType:ct, upsert:true});
        if(upErr){ console.log('[cma snapshot] photo upload failed', key, upErr.message); return null; }
        const {data:pub}=sb.storage.from('cma-photos').getPublicUrl(path);
        return (pub&&pub.publicUrl)||null;
      }catch(e:any){ console.log('[cma snapshot] rehost error', key, String(e?.message||e).slice(0,120)); return null; }
    }
    const comps=Array.isArray(body.comps)?body.comps.map((c:any)=>({...c})):[];
    for(let i=0;i<comps.length;i++){
      const c=comps[i]; if(c && c.photoUrl){ c.photoUrl=await rehost(c.photoUrl, 'comp-'+(san(c.id)||i)); }
    }
    const subjectOut:any={...subject};
    const subjPhoto=subject.photoUrl||subject.imageUrl||subject.photo||null;   // no-op today (subject has no photo)
    if(subjPhoto){ subjectOut.photoUrl=await rehost(subjPhoto,'subject'); }

    // 4) Acquisition: freeze the computeDeal RESULT so the public page renders without recomputing.
    let acquisition:any=null;
    if(includeAcq && body.da_inputs){ try{ acquisition=computeDeal(body.da_inputs, borrowerName, propertyAddress); }catch(_e){ acquisition=null; } }

    // 5) Freeze the full object.
    const data:any={
      v:1,
      subject:subjectOut,
      value:body.value||null,
      stats:body.stats||null,
      comps,
      rental,
      acquisition,
      da_inputs: includeAcq ? (body.da_inputs||null) : null,
      include_acquisition:includeAcq,
      include_rentals:includeRentals,
      borrower_name:borrowerName,
      property_address:propertyAddress,
      generated_at:new Date().toISOString(),
    };

    // 6) Insert the snapshot + a /cma short link.
    const url=`https://homes.ratesandrealty.com/cma/${slug}`;
    const {error:insErr}=await sb.from('cma_snapshots').insert({
      slug, contact_id:contactId, data, borrower_name:borrowerName, property_address:propertyAddress,
      include_acquisition:includeAcq, include_rentals:includeRentals,
    });
    if(insErr) throw new Error('snapshot insert failed: '+insErr.message);
    const {error:slErr}=await sb.from('short_links').insert({ slug, destination_url:url, contact_id:contactId });
    if(slErr) console.log('[cma snapshot] short_links insert warning:', slErr.message);   // non-fatal: /cma/<slug> serves from cma_snapshots

    return jsonRes({ ok:true, slug, url });
  }catch(e:any){
    console.error('[generate-cma snapshot]', e?.message||e);
    return jsonRes({ ok:false, error:e?.message||'Snapshot failed' }, 500);
  }
}

Deno.serve(async (req:Request)=>{
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  /* GUARD FIRST — before req.json(), so an action added later is covered by
     default rather than by remembering. verify_jwt=true does NOT do this:
     the anon key is a project-signed JWT printed in every page's source, so
     the pin alone left this reachable by anyone who read the HTML.
     See docs/PINNED-NOT-GUARDED.md. */
  const _auth = await requireStaff(req);
  if (!_auth.ok) return new Response(JSON.stringify({ error: _auth.msg || 'not authorized' }),
    { status: _auth.status || 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  try{
    const body=await req.json();

    // ── SNAPSHOT MODE (hosted /cma/<slug>) ── additive; the default PDF path below is untouched
    // and only runs when body.mode !== 'snapshot'. Reuses fetchRentAVM + computeDeal + the same
    // plain photo fetch the PDF uses; freezes the payload into cma_snapshots + a /cma short link.
    if(body && body.mode==='snapshot') return await buildCMASnapshot(body);

    const doc=await buildCMADoc(body);

    if(body.include_acquisition && body.da_inputs){
      try{
        const dealPayload=computeDeal(body.da_inputs, vv(body.borrower_name), vv(body.property_address)||vv(body.subject?.address));
        const res=await fetch(`${SUPABASE_URL}/functions/v1/generate-deal-analysis`,{
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':`Bearer ${SERVICE_KEY}`,'apikey':SERVICE_KEY},
          body:JSON.stringify(dealPayload),
        });
        const j=await res.json();
        if(j&&j.success&&j.pdf){
          const dealBytes=Uint8Array.from(atob(j.pdf),c=>c.charCodeAt(0));
          const dealDoc=await PDFDocument.load(dealBytes);
          const RR=await doc.embedFont(StandardFonts.Helvetica);
          const BB=await doc.embedFont(StandardFonts.HelveticaBold);
          const II2=await doc.embedFont(StandardFonts.HelveticaOblique);
          const wrap=(page:any,font:any,text:string,x:number,yStart:number,maxW:number,size:number,color:any,lg=2)=>{const words=san(text).split(' ');let line='',yy=yStart;for(const w of words){const t=line?line+' '+w:w;if(font.widthOfTextAtSize(t,size)>maxW&&line){page.drawText(line,{x,y:yy,size,font,color});yy-=size+lg;line=w;}else line=t;}if(line){page.drawText(line,{x,y:yy,size,font,color});yy-=size+lg;}return yy;};
          // The deal-analysis function renders on a tall 850x1350 canvas whose content only
          // fills the top region. Crop + scale to fill width, top-align, then add a short
          // plain-English client guide in the empty space below.
          for(const dp of dealDoc.getPages()){
            const ds=dp.getSize(); const pw=ds.width, ph=ds.height; const tall=ph>1200;
            const cropBottom = tall ? 472 : 0;
            const cropTop = tall ? Math.min(ph,1334) : ph;
            const emb=await doc.embedPage(dp, {left:0, bottom:cropBottom, right:pw, top:cropTop});
            const np=doc.addPage([W,H]);
            const sc=Math.min(W/emb.width, H/emb.height);
            const dw=emb.width*sc, dh=emb.height*sc;
            const topGap = tall ? 12 : (H-dh)/2;
            const contentBottom = Math.max(0, H-dh-topGap);
            np.drawPage(emb,{x:(W-dw)/2,y:contentBottom,width:dw,height:dh});
            if(tall && contentBottom>120){
              const NP=mk(np);
              const di=body.da_inputs||{};
              const rentV=num(di.rent), vacV=num(di.vacancy_pct), opexV=num(di.opex_pct);
              const effR=Math.round(rentV*(1-vacV/100)), opA=Math.round(rentV*(opexV/100));
              const bx=M, bw=CW, btop=contentBottom-12, bbot=28, bh=btop-bbot;
              NP.RX(bx,bbot,bw,bh,BGRAY); NP.RX(bx,bbot,3,bh,GOLD);
              let gy=btop-14;
              NP.T('UNDERSTANDING YOUR OPTIONS  ·  A PLAIN-ENGLISH GUIDE',bx+12,gy,BB,8,GOLD); gy-=4;
              NP.HL(bx+12,gy,bw-24,LGRAY,0.6); gy-=12;
              const colW=(bw-24-2*14)/3, c1=bx+12, c2=c1+colW+14, c3=c2+colW+14;
              NP.T('FIX & FLIP',c1,gy,BB,7,DARK); NP.T('BRRRR',c2,gy,BB,7,DARK); NP.T('BUY & HOLD',c3,gy,BB,7,DARK);
              const yy=gy-11;
              const e1=wrap(np,RR,'Buy under market, renovate, and resell for a one-time profit. Faster cash, but you carry the rehab and resale risk.',c1,yy,colW-2,6.5,rgb(0.30,0.30,0.30));
              const e2=wrap(np,RR,'Buy, renovate, rent, then refinance to pull most of your cash back out and keep the home long-term.',c2,yy,colW-2,6.5,rgb(0.30,0.30,0.30));
              const e3=wrap(np,RR,'Buy and rent on a standard mortgage for steady monthly cash flow and slow equity growth. The simplest path.',c3,yy,colW-2,6.5,rgb(0.30,0.30,0.30));
              let gy2=Math.min(e1,e2,e3)-6;
              NP.HL(bx+12,gy2+4,bw-24,LGRAY,0.5); gy2-=4;
              NP.T('HOW MONTHLY CASH FLOW IS FIGURED',bx+12,gy2,BB,7,GOLD); gy2-=10;
              const cf='Gross rent minus vacancy = effective rent; then minus operating expenses and the loan payment. For this deal: '+money(rentV)+' rent - '+fmt(vacV)+'% vacancy = '+money(effR)+'/mo effective, minus op-ex ('+fmt(opexV)+'% = '+money(opA)+'/mo), minus each strategy\'s loan payment = the cash flow shown above. A DSCR of 1.0+ means the rent covers the loan; Cash-on-Cash is that yearly cash flow divided by the cash you put in.';
              wrap(np,RR,cf,bx+12,gy2,bw-24,6.5,rgb(0.30,0.30,0.30),2.5);
            }
          }
        } else {
          console.log('[generate-cma] deal-analysis returned no pdf:', JSON.stringify(j).slice(0,200));
        }
      }catch(mergeErr){ console.log('[generate-cma] acquisition merge failed:', String(mergeErr).slice(0,200)); }
    }

    const bytes=await doc.save();
    return new Response(JSON.stringify({success:true,pdf:u8b64(bytes),type:'application/pdf'}),{headers:{...cors,'Content-Type':'application/json'}});
  }catch(e:any){
    console.error('generate-cma:',e);
    return new Response(JSON.stringify({error:e?.message||'Server error'}),{status:500,headers:{...cors,'Content-Type':'application/json'}});
  }
});

// page-bound drawing primitives
function mk(page:any){
  const T=(s:any,x:number,yy:number,f:any,sz:number,c:any,mw?:number)=>{const t=san(s);if(!t)return;if(mw){page.drawText(truncate(f,t,sz,mw),{x,y:yy,size:sz,font:f,color:c});}else page.drawText(t,{x,y:yy,size:sz,font:f,color:c});};
  const HL=(x:number,yy:number,w:number,c:any=LGRAY,sw=0.5)=>page.drawLine({start:{x,y:yy},end:{x:x+w,y:yy},thickness:sw,color:c});
  const RX=(x:number,yy:number,w:number,h:number,fill?:any,stroke?:any,sw=0.5)=>page.drawRectangle({x,y:yy,width:w,height:h,color:fill,borderColor:stroke,borderWidth:stroke?sw:0});
  const ctr=(s:any,f:any,sz:number,x:number,w:number)=>x+(w-f.widthOfTextAtSize(san(s),sz))/2;
  return {T,HL,RX,ctr};
}

function drawImageCover(page:any,img:any,x:number,y:number,w:number,h:number){
  const s=Math.max(w/img.width,h/img.height), dw=img.width*s, dh=img.height*s;
  const dx=x+(w-dw)/2, dy=y+(h-dh)/2;
  page.pushOperators(pushGraphicsState(), moveTo(x,y), lineTo(x+w,y), lineTo(x+w,y+h), lineTo(x,y+h), closePath(), clip(), endPath());
  page.drawImage(img,{x:dx,y:dy,width:dw,height:dh});
  page.pushOperators(popGraphicsState());
}

// clickable URI link annotation over a rectangle
function addLink(doc:any,page:any,x:number,y:number,w:number,h:number,url:string){
  try{
    const ann=doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[x,y,x+w,y+h],Border:[0,0,0],A:{Type:'Action',S:'URI',URI:PDFString.of(url)}});
    const ref=doc.context.register(ann);
    let annots=page.node.get(PDFName.of('Annots'));
    if(!annots){annots=doc.context.obj([]);page.node.set(PDFName.of('Annots'),annots);}
    annots.push(ref);
  }catch(e){console.log('[link]',String(e).slice(0,60));}
}

async function buildCMADoc(d:any){
  const doc=await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const R=await doc.embedFont(StandardFonts.Helvetica);
  const B=await doc.embedFont(StandardFonts.HelveticaBold);
  const I=await doc.embedFont(StandardFonts.HelveticaOblique);

  // embed brand assets ONCE, reuse across pages
  let logoImg:any=null, hsImg:any=null, qrImg:any=null;
  try{ logoImg=await doc.embedPng(b64ToU8(LOGO_PNG_B64)); }catch(e){ console.log('[logo]',String(e).slice(0,60)); }
  try{ hsImg=await tryEmbedImage(doc, HEADSHOT_URL); }catch(e){ console.log('[head]',String(e).slice(0,60)); }
  try{ qrImg=await tryEmbedImage(doc, QR_URL); }catch(e){ console.log('[qr]',String(e).slice(0,60)); }

  const loName=vv(d.lo_name,'Rene Duarte'), loNmls=vv(d.lo_nmls,'1795044');
  const loPhone=vv(d.lo_phone,'(714) 472-8508'), loEmail=vv(d.lo_email,'rene@ratesandrealty.com');
  const company=vv(d.company_name,'Rates & Realty'), coNmls=vv(d.company_nmls,'1416824');

  const subj=d.subject||{}, val=d.value||{}, stats=d.stats||{}, comps=Array.isArray(d.comps)?d.comps.slice(0,12):[];
  const addr=vv(subj.address);
  const est=parseFloat(val.estimate), low=parseFloat(val.low), high=parseFloat(val.high);
  const subjSqft=num(subj.squareFootage);
  const avgPpsf=num(stats.avgPricePerSqft);
  const radius=stats.radiusMiles??1;
  const issueDate=new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  const refNum='CMA-'+Date.now().toString(36).toUpperCase().slice(-7);

  // shared header: dark bar + logo + headshot + gold banner. returns y at bottom of banner.
  function drawHeader(page:any, bannerText:string){
    const {T,RX,ctr}=mk(page);
    const HDR=62; RX(0,H-HDR,W,HDR,DARK);
    if(logoImg){ page.drawImage(logoImg,{x:M,y:H-HDR+10,width:42,height:42}); T(company,M+50,H-24,B,18,GOLD); }
    else { T(company,M,H-24,B,18,GOLD); }
    T(`AI-Powered Mortgage  |  NMLS #${coNmls}`,M+50,H-38,R,7.5,GRAY);
    const hsSize=44, hsX=W-M-hsSize, hsY=H-HDR+9;
    const loLines=[{t:loName,f:B,sz:10.5,c:WHITE},{t:`Loan Officer  |  NMLS #${loNmls}`,f:R,sz:7.5,c:GRAY},{t:loPhone,f:R,sz:7.5,c:GRAY},{t:loEmail,f:R,sz:7.5,c:GRAY}];
    if(hsImg){
      const cx=hsX+hsSize/2, cy=hsY+hsSize/2, r=hsSize/2, k=0.5522847498;
      page.drawCircle({x:cx,y:cy,size:r+2,color:GOLD});
      page.pushOperators(
        pushGraphicsState(),
        moveTo(cx+r,cy),
        appendBezierCurve(cx+r,cy+r*k,cx+r*k,cy+r,cx,cy+r),
        appendBezierCurve(cx-r*k,cy+r,cx-r,cy+r*k,cx-r,cy),
        appendBezierCurve(cx-r,cy-r*k,cx-r*k,cy-r,cx,cy-r),
        appendBezierCurve(cx+r*k,cy-r,cx+r,cy-r*k,cx+r,cy),
        closePath(), clip(), endPath(),
      );
      page.drawImage(hsImg,{x:hsX,y:hsY,width:hsSize,height:hsSize});
      page.pushOperators(popGraphicsState());
      let loY=H-20; for(const l of loLines){const tw=l.f.widthOfTextAtSize(l.t,l.sz);T(l.t,hsX-8-tw,loY,l.f,l.sz,l.c);loY-=l.sz+3.5;}
    } else {
      let loY=H-20; for(const l of loLines){const tw=l.f.widthOfTextAtSize(l.t,l.sz);T(l.t,W-M-tw,loY,l.f,l.sz,l.c);loY-=l.sz+3.5;}
    }
    const banY=H-HDR; RX(0,banY-20,W,20,GOLD);
    T(bannerText,ctr(bannerText,B,8.5,0,W),banY-14,B,8.5,DARK);
    return banY-20;
  }

  // =================== PAGE 1 — SUMMARY ===================
  const page=doc.addPage([W,H]);
  const {T,HL,RX,ctr}=mk(page);
  const banBottom=drawHeader(page,'COMPARATIVE MARKET ANALYSIS');

  const datY=banBottom; RX(0,datY-28,W,28,BGRAY); HL(0,datY-28,W,LGRAY);
  for(const dc of [{lbl:'PREPARED',val:issueDate,x:M},{lbl:'REFERENCE',val:refNum,x:W/2-30},{lbl:'SEARCH RADIUS',val:radius+' mile'+(radius==1?'':'s'),x:W-M-130}]){
    T(dc.lbl,dc.x,datY-9,R,6,GRAY);T(dc.val,dc.x,datY-20,B,8.5,DARK);
  }
  let y=datY-40;

  T('SUBJECT PROPERTY',M,y,B,6.5,GOLD); HL(M,y-3,CW,GOLD,0.6); y-=15;
  T(addr||'(address not specified)',M,y,B,13,DARK,CW); y-=15;
  const chips:string[]=[];
  if(subj.propertyType)chips.push(san(subj.propertyType));
  if(subj.bedrooms!=null)chips.push(subj.bedrooms+' bd');
  if(subj.bathrooms!=null)chips.push(subj.bathrooms+' ba');
  if(subj.squareFootage!=null)chips.push(fmt(subj.squareFootage)+' sqft');
  chips.push(`Valued from ${comps.length} comparable sale${comps.length===1?'':'s'} within ${radius} mi`);
  T(chips.join('   •   '),M,y,R,8,GRAY,CW); y-=16;

  const boxH=64; RX(M-3,y-boxH,CW+6,boxH,BGRAY); RX(M-3,y-boxH,3,boxH,GOLD);
  T('ESTIMATED MARKET VALUE',M+8,y-13,R,6.5,GRAY);
  T(money(est),M+8,y-38,B,26,GOLD);
  T(`${money(low)}  –  ${money(high)} likely range`,M+8,y-52,R,8,rgb(0.30,0.30,0.30));
  if(!isNaN(low)&&!isNaN(high)&&high>low){
    const gW=210, gX=W-M-gW-12, gY=y-34, frac=Math.max(0,Math.min(1,(est-low)/(high-low)));
    RX(gX,gY,gW,5,TRACK); RX(gX,gY,gW*frac,5,GOLD);
    const mx=gX+gW*frac;
    page.drawCircle({x:mx,y:gY+2.5,size:5,color:DARK}); page.drawCircle({x:mx,y:gY+2.5,size:3,color:GOLD});
    T('LOW',gX,gY-11,R,6,GRAY); T(moneyK(low),gX,gY-20,B,7.5,DARK);
    const hk=moneyK(high); T('HIGH',gX+gW-R.widthOfTextAtSize('HIGH',6),gY-11,R,6,GRAY); T(hk,gX+gW-B.widthOfTextAtSize(hk,7.5),gY-20,B,7.5,DARK);
    T('AVM',ctr('AVM',R,6,mx-12,24),gY+18,R,6,GRAY); T(moneyK(est),ctr(moneyK(est),B,7.5,mx-16,32),gY+9,B,7.5,GOLD);
  }
  y-=boxH+14;

  const cards=[
    {lbl:'AVG $/SQFT',val:stats.avgPricePerSqft!=null?'$'+fmt(stats.avgPricePerSqft):'—'},
    {lbl:'MEDIAN PRICE',val:money(stats.medianPrice)},
    {lbl:'AVERAGE PRICE',val:money(stats.avgPrice)},
    {lbl:'COMPARABLES',val:String(stats.compCount??comps.length)},
  ];
  const cardW=(CW-3*8)/4, cardH=40;
  for(let i=0;i<cards.length;i++){
    const cx=M+i*(cardW+8);
    RX(cx,y-cardH,cardW,cardH,WHITE,LGRAY,0.6); RX(cx,y-cardH,cardW,2,GOLD);
    T(cards[i].lbl,ctr(cards[i].lbl,R,6,cx,cardW),y-15,R,6,GRAY);
    T(cards[i].val,ctr(cards[i].val,B,13,cx,cardW),y-32,B,13,DARK);
  }
  y-=cardH+16;

  T('COMPARABLE SALES  ·  PRICE COMPARISON',M,y,B,6.5,GOLD); HL(M,y-3,CW,GOLD,0.6); y-=14;
  const labelW=132, chartX=M+labelW, chartW=CW-labelW-58, rowH=17;
  const prices=comps.map((c:any)=>parseFloat(c.price)).filter((x:number)=>!isNaN(x));
  const maxV=Math.max(est||0,...prices)*1.06||1;
  if(!isNaN(est)){
    const sx=chartX+chartW*(est/maxV);
    page.drawLine({start:{x:sx,y:y+4},end:{x:sx,y:y-comps.length*rowH-2},thickness:1,color:GOLD,dashArray:[3,2]});
    T('Subject AVM '+moneyK(est),sx-R.widthOfTextAtSize('Subject AVM '+moneyK(est),6)/2,y+7,R,6,rgb(0.55,0.45,0.18));
  }
  for(let i=0;i<comps.length;i++){
    const c=comps[i], price=parseFloat(c.price)||0, cy=y-i*rowH-rowH+5;
    const sold=c.status&&String(c.status).indexOf('Sold')>-1;
    const bw=Math.max(2,chartW*(price/maxV));
    const shortAddr=san(c.address||'').replace(/, Santa Ana.*$/i,'').replace(/,.*$/,'');
    T(truncate(R,shortAddr,7,labelW-6),M,cy+2,R,7,DARK);
    RX(chartX,cy,bw,9,sold?SOLDBAR:ACTBAR);
    T(money(price),chartX+bw+4,cy+1.5,B,7,DARK);
  }
  y-=comps.length*rowH+8;
  RX(M,y-1,8,7,SOLDBAR); T('Sold / Off-market',M+12,y,R,7,GRAY);
  RX(M+108,y-1,8,7,ACTBAR); T('Active listing',M+120,y,R,7,GRAY);
  y-=16;

  T('COMPARABLE SALES  ·  DETAIL',M,y,B,6.5,GOLD); HL(M,y-3,CW,GOLD,0.6); y-=12;
  const cols=[
    {h:'#',w:16,a:'l'},{h:'ADDRESS',w:150,a:'l'},{h:'BD/BA',w:38,a:'l'},{h:'SQFT',w:42,a:'r'},
    {h:'PRICE',w:62,a:'r'},{h:'$/SQFT',w:46,a:'r'},{h:'DIST',w:34,a:'r'},{h:'STATUS',w:64,a:'l'},{h:'DATE',w:42,a:'r'},
  ];
  let tx=M; const colX=cols.map(c=>{const x=tx;tx+=c.w;return x;});
  const thH=15; RX(M,y-thH,CW,thH,DARK);
  for(let i=0;i<cols.length;i++){const c=cols[i],x=colX[i];if(c.a==='r')T(c.h,x+c.w-R.widthOfTextAtSize(c.h,6),y-10,B,6,GOLD);else T(c.h,x+3,y-10,B,6,GOLD);}
  y-=thH;
  const rH=15;
  for(let i=0;i<comps.length;i++){
    const c=comps[i], sold=c.status&&String(c.status).indexOf('Sold')>-1;
    if(i%2===1)RX(M,y-rH,CW,rH,BGRAY);
    const cells=[String(i+1),san(c.address||'').replace(/, Santa Ana.*$/i,''),(c.bedrooms!=null?c.bedrooms:'—')+'/'+(c.bathrooms!=null?c.bathrooms:'—'),
      c.squareFootage!=null?fmt(c.squareFootage):'—',money(c.price),c.pricePerSqft!=null?'$'+fmt(c.pricePerSqft):'—',
      c.distance!=null?Number(c.distance).toFixed(2):'—',statusShort(c.status),dt(c.removedDate||c.lastSeenDate)];
    for(let j=0;j<cols.length;j++){
      const col=cols[j],x=colX[j],sz=7,f=j===4?B:R;let color=DARK;if(j===7)color=sold?GREEN:BLUE;
      const txt=truncate(f,String(cells[j]),sz,col.w-4);
      if(col.a==='r')T(txt,x+col.w-f.widthOfTextAtSize(txt,sz)-2,y-10,f,sz,color);else T(txt,x+3,y-10,f,sz,color);
    }
    HL(M,y-rH,CW,LGRAY,0.4); y-=rH;
  }
  y-=14;

  HL(M,y,CW,LGRAY); y-=9;
  const disc=`Comparative Market Analysis prepared ${issueDate} using ${comps.length} comparable sale${comps.length===1?'':'s'} within a ${radius}-mile radius of the subject property. `+
    `The Estimated Market Value is an automated valuation (AVM) provided by RentCast and is intended for informational and pre-qualification purposes only. `+
    `It is not an appraisal, does not constitute an offer to lend, and should not be relied upon as a guarantee of value. Actual market value is subject to a licensed appraisal, property condition, and current market conditions. `+
    `Prepared by ${loName}, NMLS #${loNmls}  ·  ${company}, NMLS #${coNmls}  ·  ${loPhone}  ·  ${loEmail}`;
  {const words=san(disc).split(' ');let line='',cy=y;const mw=CW-80,sz=5.5;
   for(const w of words){const t=line?line+' '+w:w;if(I.widthOfTextAtSize(t,sz)>mw&&line){page.drawText(line,{x:M,y:cy,size:sz,font:I,color:GRAY});cy-=sz+2.5;line=w;}else line=t;}
   if(line)page.drawText(line,{x:M,y:cy,size:sz,font:I,color:GRAY});}

  if(qrImg){
    const qrSize=64, qrX=W-M-qrSize, qrY=M+12;
    page.drawImage(qrImg,{x:qrX,y:qrY,width:qrSize,height:qrSize});
    T('Scan to connect',qrX+(qrSize-R.widthOfTextAtSize('Scan to connect',5.5))/2,qrY-8,R,5.5,GRAY);
  }

  // =================== RENTAL PAGE (optional) ===================
  let rental:any = d.rental || null;
  if(!rental && d.include_rentals){ rental = await fetchRentAVM(subj); }
  if(rental && (rental.estimate!=null || (Array.isArray(rental.comps)&&rental.comps.length))){
    const rcomps=(Array.isArray(rental.comps)?rental.comps:[]).slice(0,12);
    const rp=doc.addPage([W,H]); const RP=mk(rp);
    const rbat=drawHeader(rp,'RENTAL MARKET ANALYSIS');
    RP.RX(0,rbat-28,W,28,BGRAY); RP.HL(0,rbat-28,W,LGRAY);
    for(const dc of [{lbl:'PREPARED',val:issueDate,x:M},{lbl:'REFERENCE',val:refNum+'-R',x:W/2-30},{lbl:'BASIS',val:'Long-term rentals',x:W-M-130}]){ RP.T(dc.lbl,dc.x,rbat-9,R,6,GRAY); RP.T(dc.val,dc.x,rbat-20,B,8.5,DARK); }
    let ry=rbat-40;
    RP.T('SUBJECT PROPERTY',M,ry,B,6.5,GOLD); RP.HL(M,ry-3,CW,GOLD,0.6); ry-=15;
    RP.T(addr||'(address not specified)',M,ry,B,13,DARK,CW); ry-=15;
    const rchips:string[]=[]; if(subj.propertyType)rchips.push(san(subj.propertyType)); if(subj.bedrooms!=null)rchips.push(subj.bedrooms+' bd'); if(subj.bathrooms!=null)rchips.push(subj.bathrooms+' ba'); if(subj.squareFootage!=null)rchips.push(fmt(subj.squareFootage)+' sqft'); rchips.push('Estimated from '+rcomps.length+' rental comparable'+(rcomps.length===1?'':'s'));
    RP.T(rchips.join('   \u2022   '),M,ry,R,8,GRAY,CW); ry-=18;
    const rest=parseFloat(rental.estimate),rlow=parseFloat(rental.low),rhigh=parseFloat(rental.high);
    const rboxH=58; RP.RX(M-3,ry-rboxH,CW+6,rboxH,BGRAY); RP.RX(M-3,ry-rboxH,3,rboxH,GOLD);
    RP.T('ESTIMATED MONTHLY RENT',M+8,ry-13,R,6.5,GRAY);
    RP.T((isNaN(rest)?'\u2014':money(rest)+' / mo'),M+8,ry-38,B,24,GOLD);
    if(!isNaN(rlow)&&!isNaN(rhigh)) RP.T(money(rlow)+'  \u2013  '+money(rhigh)+' / mo likely range',M+8,ry-50,R,8,rgb(0.30,0.30,0.30));
    ry-=rboxH+16;
    const rrents=rcomps.map((c:any)=>parseFloat(c.rent)).filter((x:number)=>!isNaN(x));
    const rppsf=rcomps.map((c:any)=>{const rr=parseFloat(c.rent),sf=parseFloat(c.squareFootage);return (rr&&sf)?rr/sf:NaN;}).filter((x:number)=>!isNaN(x));
    const ravg=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0; const rmed=(a:number[])=>{if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
    const rcards=[{lbl:'AVG RENT',val:rrents.length?money(Math.round(ravg(rrents))):'\u2014'},{lbl:'MEDIAN RENT',val:rrents.length?money(Math.round(rmed(rrents))):'\u2014'},{lbl:'AVG RENT/SQFT',val:rppsf.length?('$'+ravg(rppsf).toFixed(2)):'\u2014'},{lbl:'RENTAL COMPS',val:String(rcomps.length)}];
    const rcW=(CW-3*8)/4,rcH=40; for(let i=0;i<rcards.length;i++){const cx=M+i*(rcW+8); RP.RX(cx,ry-rcH,rcW,rcH,WHITE,LGRAY,0.6); RP.RX(cx,ry-rcH,rcW,2,GOLD); RP.T(rcards[i].lbl,ctr(rcards[i].lbl,R,6,cx,rcW),ry-15,R,6,GRAY); RP.T(rcards[i].val,ctr(rcards[i].val,B,13,cx,rcW),ry-32,B,13,DARK);}
    ry-=rcH+18;
    RP.T('RENTAL COMPARABLES  \u00b7  DETAIL',M,ry,B,6.5,GOLD); RP.HL(M,ry-3,CW,GOLD,0.6); ry-=12;
    const rcols=[{h:'#',w:18,a:'l'},{h:'ADDRESS',w:200,a:'l'},{h:'BD/BA',w:46,a:'l'},{h:'SQFT',w:52,a:'r'},{h:'RENT/MO',w:76,a:'r'},{h:'RENT/SF',w:54,a:'r'},{h:'DIST',w:38,a:'r'},{h:'DOM',w:40,a:'r'}];
    let rtx=M;const rcolX=rcols.map((c)=>{const x=rtx;rtx+=c.w;return x;});
    const rthH=16; RP.RX(M,ry-rthH,CW,rthH,DARK); for(let i=0;i<rcols.length;i++){const c=rcols[i],x=rcolX[i];if(c.a==='r')RP.T(c.h,x+c.w-R.widthOfTextAtSize(c.h,6.5),ry-11,B,6.5,GOLD);else RP.T(c.h,x+4,ry-11,B,6.5,GOLD);} ry-=rthH;
    const rrH=17; for(let i=0;i<rcomps.length;i++){const c=rcomps[i];if(i%2===1)RP.RX(M,ry-rrH,CW,rrH,BGRAY); const rr=parseFloat(c.rent),sf=parseFloat(c.squareFootage); const cells=[String(i+1),san(c.address||'').replace(/,\s*(CA|California)\b.*$/i,''),(c.bedrooms!=null?c.bedrooms:'\u2014')+'/'+(c.bathrooms!=null?c.bathrooms:'\u2014'),sf?fmt(sf):'\u2014',!isNaN(rr)?money(rr):'\u2014',(rr&&sf)?'$'+(rr/sf).toFixed(2):'\u2014',c.distance!=null?Number(c.distance).toFixed(2):'\u2014',c.daysOnMarket!=null?san(c.daysOnMarket):'\u2014']; for(let j=0;j<rcols.length;j++){const col=rcols[j],x=rcolX[j],sz=7.5,f=j===4?B:R;const txt=truncate(f,String(cells[j]),sz,col.w-4);if(col.a==='r')RP.T(txt,x+col.w-f.widthOfTextAtSize(txt,sz)-3,ry-11,f,sz,DARK);else RP.T(txt,x+4,ry-11,f,sz,DARK);} RP.HL(M,ry-rrH,CW,LGRAY,0.4); ry-=rrH; }
    ry-=14; RP.HL(M,ry,CW,LGRAY); ry-=9;
    const rdisc='Rental estimate and comparables provided by RentCast for informational purposes only. The estimated monthly rent is an automated valuation (AVM), not a guarantee of achievable rent, and is subject to property condition, lease terms, and market conditions. Prepared by '+loName+', NMLS #'+loNmls+'  \u00b7  '+company+', NMLS #'+coNmls+'.';
    {const words=san(rdisc).split(' ');let line='',cyy=ry;const mw=CW-10,sz=5.5;for(const w of words){const t=line?line+' '+w:w;if(I.widthOfTextAtSize(t,sz)>mw&&line){rp.drawText(line,{x:M,y:cyy,size:sz,font:I,color:GRAY});cyy-=sz+2.5;line=w;}else line=t;}if(line)rp.drawText(line,{x:M,y:cyy,size:sz,font:I,color:GRAY});}
    RP.HL(M,M+6,CW,LGRAY,0.4); RP.T(company+'  \u00b7  Rental market analysis  \u00b7  '+loName+', NMLS #'+loNmls+'  \u00b7  '+loPhone,M,M-4,I,6,GRAY);
  }

  // =================== MAP PAGE (Google Static Maps) ===================
  const sLat=num(subj.latitude), sLng=num(subj.longitude);
  if(GMAPS_KEY && sLat && sLng){
    const mp=doc.addPage([W,H]);
    const MP=mk(mp);
    const mtop=drawHeader(mp,'MAP OF COMPARABLE LISTINGS');
    let my=mtop-26;
    MP.T('SUBJECT PROPERTY & COMPARABLES',M,my,B,6.5,GOLD); MP.HL(M,my-3,CW,GOLD,0.6); my-=14;
    const colorFor=(st:string)=>{ if(/sold|closed|off-?market/i.test(st))return '0x2C7A4B'; if(/withdraw/i.test(st))return '0x6B7280'; if(/cancel/i.test(st))return '0xC8881F'; if(/pend/i.test(st))return '0xE0A100'; return '0x2A6BBF'; };
    const stColor=(st:string)=>{ if(/sold|closed|off-?market/i.test(st))return rgb(0.173,0.478,0.294); if(/withdraw/i.test(st))return rgb(0.42,0.45,0.50); if(/cancel/i.test(st))return rgb(0.784,0.533,0.122); if(/pend/i.test(st))return rgb(0.878,0.627,0.0); return rgb(0.165,0.42,0.749); };
    const pinLabel=(idx:number)=>idx<9?String(idx+1):String.fromCharCode(65+idx-9);
    const parts:string[]=[];
    parts.push(`markers=${encodeURIComponent(`color:0x7E3FF2|label:S|${sLat},${sLng}`)}`);
    comps.forEach((c:any,idx:number)=>{
      const la=num(c.latitude),ln=num(c.longitude); if(!la||!ln)return;
      parts.push(`markers=${encodeURIComponent(`color:${colorFor(String(c.status||''))}|label:${pinLabel(idx)}|${la},${ln}`)}`);
    });
    const mapH=360, mpx=M, mpy0=my-mapH;
    const mapUrl=`https://maps.googleapis.com/maps/api/staticmap?size=620x360&scale=2&maptype=roadmap&${parts.join('&')}&key=${GMAPS_KEY}`;
    const mapImg=await tryEmbedImage(doc, mapUrl);
    if(mapImg){ drawImageCover(mp,mapImg,mpx,mpy0,CW,mapH); MP.RX(mpx,mpy0,CW,mapH,undefined,LGRAY,0.8); }
    else { MP.RX(mpx,mpy0,CW,mapH,BGRAY,LGRAY,0.8); const t='Map unavailable — check GOOGLE_MAPS_API_KEY (Static Maps API)'; MP.T(t,MP.ctr(t,R,9,mpx,CW),mpy0+mapH/2,R,9,GRAY); }
    my=mpy0-20;
    const presentSt:string[]=[]; for(const c of comps){const s=statusShort(c.status); if(!presentSt.includes(s))presentSt.push(s);}
    const legItems:[string,any][]=[['Subject',rgb(0.494,0.247,0.949)]];
    for(const s of presentSt) legItems.push([s, stColor(s)]);
    let lx=M; for(const [t,col] of legItems){ mp.drawCircle({x:lx+5,y:my-3,size:5,color:col}); MP.T(t,lx+15,my-6,R,8,rgb(0.25,0.25,0.25)); lx+=15+R.widthOfTextAtSize(t,8)+22; }
    my-=22;
    MP.T('COMPARABLE LISTINGS',M,my,B,6.5,GOLD); MP.HL(M,my-3,CW,GOLD,0.6); my-=18;
    const colGap=16, half=(CW-colGap)/2, rowH=27;
    comps.forEach((c:any,idx:number)=>{
      const colIdx=idx%2, row=Math.floor(idx/2);
      const x=M+colIdx*(half+colGap), ry=my-row*rowH;
      const col=stColor(String(c.status||''));
      const lbl=pinLabel(idx);
      MP.RX(x,ry-20,half,22,rgb(0.975,0.965,0.94)); MP.RX(x,ry-20,2.5,22,col);
      const bcx=x+20, bcy=ry-9; mp.drawCircle({x:bcx,y:bcy,size:8.5,color:col});
      MP.T(lbl,bcx-B.widthOfTextAtSize(lbl,8)/2,bcy-3,B,8,WHITE);
      const stxt=statusShort(c.status), pw=B.widthOfTextAtSize(stxt,6.5)+14, ph=13, pxp=x+half-pw-7, pyp=ry-16;
      MP.RX(pxp,pyp,pw,ph,col); MP.T(stxt,pxp+(pw-B.widthOfTextAtSize(stxt,6.5))/2,pyp+4,B,6.5,WHITE);
      const addrTxt=san(c.address||'').replace(/, Santa Ana.*$/i,'').replace(/,.*$/,'');
      MP.T(truncate(B,addrTxt,8.5,pxp-(x+34)-6),x+34,ry-12,B,8.5,DARK);
    });
    MP.HL(M,M+6,CW,LGRAY,0.4);
    MP.T(`${company}  ·  Map of comparable listings  ·  ${loName}, NMLS #${loNmls}  ·  ${loPhone}`,M,M-4,I,6,GRAY);
  }

  // =================== PAGES — PER-COMP DETAIL ===================
  for(let i=0;i<comps.length;i++){
    const c=comps[i];
    const cp=doc.addPage([W,H]);
    const P=mk(cp);
    const top=drawHeader(cp,'COMPARABLE PROPERTY DETAIL');

    const sold=c.status&&String(c.status).indexOf('Sold')>-1;
    const distTxt=c.distance!=null?Number(c.distance).toFixed(2)+' mi from subject':'—';
    const sy=top; P.RX(0,sy-28,W,28,BGRAY); P.HL(0,sy-28,W,LGRAY);
    for(const dc of [{lbl:'COMPARABLE',val:`${i+1} of ${comps.length}`,x:M},{lbl:'STATUS',val:statusText(c.status),x:W/2-30},{lbl:'DISTANCE',val:distTxt,x:W-M-150}]){
      P.T(dc.lbl,dc.x,sy-9,R,6,GRAY); P.T(dc.val,dc.x,sy-20,B,8.5,DARK);
    }
    let cy=sy-44;

    P.T('COMPARABLE PROPERTY',M,cy,B,6.5,GOLD); P.HL(M,cy-3,CW,GOLD,0.6); cy-=17;
    P.T(san(c.address)||'(address not specified)',M,cy,B,15,DARK,CW); cy-=20;

    const panelH=212, px=M, py=cy-panelH;
    const photoUrl=c.photoUrl||c.imageUrl||c.photo||(Array.isArray(c.photos)?c.photos[0]:null)||(Array.isArray(c.images)?c.images[0]:null);
    const photoImg=await tryEmbedImage(doc, photoUrl);
    if(photoImg){
      drawImageCover(cp,photoImg,px,py,CW,panelH);
    } else {
      P.RX(px,py,CW,panelH,BGRAY);
      if(logoImg){ const lw=120,lh=120; cp.drawImage(logoImg,{x:px+(CW-lw)/2,y:py+(panelH-lh)/2+8,width:lw,height:lh,opacity:0.10}); }
      const ph='Listing photo not available';
      P.T(ph,P.ctr(ph,R,9,px,CW),py+34,R,9,GRAY);
      const sub=[san(c.propertyType)||'Residential',c.yearBuilt?('Built '+san(c.yearBuilt)):''].filter(Boolean).join('   •   ');
      if(sub) P.T(sub,P.ctr(sub,R,7.5,px,CW),py+22,R,7.5,rgb(0.6,0.6,0.6));
    }
    P.RX(px,py,CW,panelH,undefined,LGRAY,0.8);
    cy=py-16;

    const mcards=[
      {lbl:'LIST / SOLD PRICE',val:money(c.price)},
      {lbl:'PRICE / SQFT',val:c.pricePerSqft!=null?'$'+fmt(c.pricePerSqft):'—'},
      {lbl:'BED / BATH',val:(c.bedrooms!=null?c.bedrooms:'—')+' / '+(c.bathrooms!=null?c.bathrooms:'—')},
      {lbl:'SQUARE FEET',val:c.squareFootage!=null?fmt(c.squareFootage):'—'},
    ];
    const mcW=(CW-3*8)/4, mcH=46;
    for(let k=0;k<mcards.length;k++){
      const x=M+k*(mcW+8);
      P.RX(x,cy-mcH,mcW,mcH,WHITE,LGRAY,0.6); P.RX(x,cy-mcH,mcW,2,GOLD);
      P.T(mcards[k].lbl,P.ctr(mcards[k].lbl,R,6,x,mcW),cy-16,R,6,GRAY);
      P.T(mcards[k].val,P.ctr(mcards[k].val,B,15,x,mcW),cy-36,B,15,DARK);
    }
    cy-=mcH+18;

    P.T('PROPERTY DETAILS',M,cy,B,6.5,GOLD); P.HL(M,cy-3,CW,GOLD,0.6); cy-=14;
    const specs:[string,string][]=[
      ['Property Type', san(c.propertyType)||'—'],
      ['Status', statusText(c.status)],
      ['Year Built', c.yearBuilt!=null?san(c.yearBuilt):'—'],
      ['Lot Size', c.lotSize!=null?fmt(c.lotSize)+' sqft':'—'],
      ['Days on Market', c.daysOnMarket!=null?san(c.daysOnMarket):'—'],
      [sold?'Sold Date':'Listed Date', dt(c.removedDate||c.lastSeenDate||c.listedDate)],
      ['Distance from Subject', c.distance!=null?Number(c.distance).toFixed(2)+' mi':'—'],
      ['Reference', refNum+'-C'+(i+1)],
    ];
    const colGap=20, halfW=(CW-colGap)/2, lineH=18;
    for(let k=0;k<specs.length;k++){
      const colIdx=k%2, rowIdx=Math.floor(k/2);
      const x=M+colIdx*(halfW+colGap), ly=cy-rowIdx*lineH;
      P.T(specs[k][0],x,ly,R,8,GRAY);
      const valW=halfW-R.widthOfTextAtSize(specs[k][0],8)-10;
      P.T(specs[k][1],x+halfW-B.widthOfTextAtSize(truncate(B,specs[k][1],8.5,valW),8.5),ly,B,8.5,DARK,valW);
      P.HL(x,ly-6,halfW,LGRAY,0.4);
    }
    cy-=Math.ceil(specs.length/2)*lineH+12;

    P.T('COMPARED TO SUBJECT',M,cy,B,6.5,GOLD); P.HL(M,cy-3,CW,GOLD,0.6); cy-=14;
    const price=num(c.price), ppsf=num(c.pricePerSqft), csqft=num(c.squareFootage);
    function vcard(label:string, diff:number, fmtAbs:(n:number)=>string, higherGood:boolean){
      const flat=Math.abs(diff)<1e-9, up=diff>0;
      const col=flat?GRAY:((up===higherGood)?GREEN:RED);
      const sign=flat?'':(up?'+':'-');
      const word=flat?'same as subject':(up?'higher':'lower');
      return {label,col,txt:sign+fmtAbs(Math.abs(diff)),word};
    }
    const comps3=[
      vcard('vs Estimated Value', (isNaN(est)?0:price-est), (n)=>money(n), false),
      vcard('vs Avg $/SQFT', (avgPpsf>0?ppsf-avgPpsf:0), (n)=>'$'+fmt(n), false),
      vcard('vs Subject SQFT', (subjSqft>0?csqft-subjSqft:0), (n)=>fmt(n)+' sf', true),
    ];
    const vcW=(CW-2*8)/3, vcH=44;
    for(let k=0;k<comps3.length;k++){
      const x=M+k*(vcW+8); const cc=comps3[k];
      P.RX(x,cy-vcH,vcW,vcH,BGRAY); P.RX(x,cy-vcH,2,vcH,cc.col);
      P.T(cc.label,x+10,cy-13,R,6.5,GRAY);
      P.T(cc.txt,x+10,cy-31,B,13,cc.col);
      P.T(cc.word,x+vcW-10-R.widthOfTextAtSize(cc.word,7),cy-31,R,7,cc.col);
    }
    cy-=vcH+14;

    if(san(c.listingUrl)){
      const lt=san(c.mlsNumber)?`View listing  (MLS #${san(c.mlsNumber)})`:'View listing';
      P.T('LISTING',M,cy,B,6.5,GOLD); P.HL(M,cy-3,CW,GOLD,0.6); cy-=14;
      P.T(lt,M,cy,B,9,BLUE);
      const lw=B.widthOfTextAtSize(lt,9);
      P.HL(M,cy-2,lw,BLUE,0.6);
      addLink(doc,cp,M,cy-3,lw,12,san(c.listingUrl));
      cy-=20;
    }

    if(san(c.description)){
      P.T('PROPERTY DESCRIPTION',M,cy,B,6.5,GOLD); P.HL(M,cy-3,CW,GOLD,0.6); cy-=13;
      const words=san(c.description).split(' ');let line='',dsz=7.5,maxLines=7,ln=0;const dcol=rgb(0.32,0.32,0.32);
      for(const w of words){const t=line?line+' '+w:w;if(R.widthOfTextAtSize(t,dsz)>CW&&line){P.T(line,M,cy,R,dsz,dcol);cy-=dsz+3;ln++;line=w;if(ln>=maxLines){line='';break;}}else line=t;}
      if(line){if(ln===maxLines-1)line=truncate(R,line+' …',dsz,CW);P.T(line,M,cy,R,dsz,dcol);cy-=12;}
    }

    P.HL(M,M+6,CW,LGRAY,0.4);
    const foot=`${company}  ·  Comparable ${i+1} of ${comps.length}  ·  ${loName}, NMLS #${loNmls}  ·  ${loPhone}`;
    P.T(foot,M,M-4,I,6,GRAY);
    P.T('AVM source: RentCast — informational only, not an appraisal.',M,M-13,I,5.5,rgb(0.62,0.62,0.62));
  }

  return doc;
}
