import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument, rgb, StandardFonts, PDFFont, PDFPage } from 'npm:pdf-lib@1.17.1';
import fontkit from 'npm:@pdf-lib/fontkit@1.1.1';

const QR_CODE_B64 = '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';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const W = 612, H = 792, M = 44, CW = W - M * 2;
const GOLD  = rgb(0.788, 0.659, 0.298);
const WHITE = rgb(1, 1, 1);
const DARK  = rgb(0.08, 0.08, 0.08);
const GRAY  = rgb(0.52, 0.52, 0.52);
const LGRAY = rgb(0.87, 0.87, 0.87);
const BGRAY = rgb(0.97, 0.96, 0.94);
const GREEN = rgb(0.086, 0.60, 0.22);
const RED   = rgb(0.82, 0.10, 0.18);
const INK   = rgb(0.04, 0.07, 0.28);

const san = (x: any): string => x == null ? '' :
  String(x).replace(/[\r\n\t]/g,' ').replace(/[\x00-\x1F\x7F]/g,'').replace(/\s+/g,' ').trim();
const v = (x: any, fb = '') => san(x) || san(fb) || '';
const fmt = (n: any, d = 0) => { const x = parseFloat(String(n||0)); return isNaN(x)?'0':x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}); };
const fmtP = (n: any) => { const x = parseFloat(String(n||0)); return isNaN(x)?'0.000%':x.toFixed(3)+'%'; };
const fmtD = (n: any) => '$' + fmt(n, 0);

function u8b64(arr: Uint8Array): string {
  let b = ''; const ch = 8192;
  for (let i = 0; i < arr.length; i += ch) b += String.fromCharCode(...arr.subarray(i, i+ch));
  return btoa(b);
}

function drawText(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size: number, color: any, maxWidth?: number) {
  const safe = san(s); if (!safe) return;
  if (maxWidth) {
    const words = safe.split(' '); let line = '', cy = y;
    for (const w of words) {
      const test = line ? line+' '+w : w;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
        page.drawText(line, {x, y:cy, size, font, color}); cy -= size + 3; line = w;
      } else line = test;
    }
    if (line) page.drawText(line, {x, y:cy, size, font, color});
    return;
  }
  page.drawText(safe, {x, y, size, font, color});
}

async function loadCursiveFont(doc: PDFDocument): Promise<PDFFont | null> {
  const ttfUrls = [
    'https://raw.githubusercontent.com/google/fonts/main/ofl/dancingscript/DancingScript-Regular.ttf',
    'https://raw.githubusercontent.com/google/fonts/main/ofl/allura/Allura-Regular.ttf',
    'https://raw.githubusercontent.com/google/fonts/main/ofl/greatvibes/GreatVibes-Regular.ttf',
    'https://raw.githubusercontent.com/google/fonts/main/ofl/pinyonscript/PinyonScript-Regular.ttf',
    'https://raw.githubusercontent.com/google/fonts/main/ofl/italianno/Italianno-Regular.ttf',
  ];
  for (const url of ttfUrls) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/octet-stream, */*' } });
      if (!res.ok) { console.log('[font] HTTP', res.status, url); continue; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const magic = bytes[0];
      if (bytes.length < 1000) { console.log('[font] Too small:', bytes.length, url); continue; }
      if (magic !== 0x00 && magic !== 0x74 && magic !== 0x4F) { console.log('[font] Bad magic:', magic.toString(16), url); continue; }
      const font = await doc.embedFont(bytes);
      console.log('[font] SUCCESS:', url, 'size:', bytes.length);
      return font;
    } catch(e) { console.log('[font] Error:', url, String(e).slice(0,80)); }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  try {
    const body = await req.json();
    const pdfBytes = await buildPDF(body);
    return new Response(JSON.stringify({success:true,pdf:u8b64(pdfBytes),type:'application/pdf'}),
      {headers:{...cors,'Content-Type':'application/json'}});
  } catch(e:any) {
    console.error('generate-preapproval:',e);
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:{...cors,'Content-Type':'application/json'}});
  }
});

async function buildPDF(d: any): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const sigFont = await loadCursiveFont(doc);
  const R   = await doc.embedFont(StandardFonts.Helvetica);
  const B   = await doc.embedFont(StandardFonts.HelveticaBold);
  const I   = await doc.embedFont(StandardFonts.HelveticaOblique);
  const TBI = await doc.embedFont(StandardFonts.TimesRomanBoldItalic);
  const page = doc.addPage([W, H]);

  const loName     = v(d.lo_name,'Rene Duarte');
  const loNmls     = v(d.lo_nmls,'1795044');
  const loPhone    = v(d.lo_phone,'(714) 472-8508');
  const loEmail    = v(d.lo_email,'rene@ratesandrealty.com');
  const company    = v(d.company_name,'Rates & Realty');
  const coNmls     = v(d.company_nmls,'1416824');
  const brokerName = 'E Mortgage Capital, LLC';
  const brokerNmls = '1416824';
  const brokerAddr = '3750 S. Susan Street, Suite 100, Santa Ana, CA 92704';
  const borrower   = v(d.borrower_name);
  const coBorrower = v(d.co_borrower_name);
  const loanAmt    = parseFloat(String(d.loan_amount||0));
  const purchPrice = parseFloat(String(d.purchase_price||0));
  const downPay    = parseFloat(String(d.down_payment||0));
  const rate       = parseFloat(String(d.interest_rate||0));
  const termMo     = parseInt(String(d.loan_term_months||360));
  const ltv        = parseFloat(String(d.ltv||0));
  const cltv       = parseFloat(String(d.cltv||ltv||0));
  const pi         = parseFloat(String(d.pi_payment||0));
  const taxes      = parseFloat(String(d.taxes_monthly||0));
  const ins        = parseFloat(String(d.insurance_monthly||0));
  const mi         = parseFloat(String(d.mi_monthly||0));
  const hoa        = parseFloat(String(d.hoa_monthly||0));
  const fDTI       = parseFloat(String(d.front_dti||0));
  const bDTI       = parseFloat(String(d.back_dti||0));
  const loanType   = v(d.loan_type,'Conventional');
  const loanProg   = v(d.loan_program,'30-Year Fixed');
  const purpose    = v(d.loan_purpose,'Purchase');
  const rawOcc     = v(d.occupancy_type,'Primary Residence');
  const occ        = rawOcc.charAt(0).toUpperCase() + rawOcc.slice(1).replace(/\bresidence\b/i,'Residence');
  const cscoreRaw  = parseFloat(String(d.credit_score||0));
  const cscore     = cscoreRaw > 0 ? String(Math.round(cscoreRaw)) : '';
  const propAddr   = [d.property_address,d.property_city,d.property_state,d.property_zip].filter(Boolean).join(', ');
  const issueDate  = v(d.issue_date)||new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  const validDays  = parseInt(String(d.valid_days||90));
  const expiryDate = v(d.expiry_date)||new Date(Date.now()+validDays*86400000).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  const refNum     = 'RR-'+Date.now().toString(36).toUpperCase().slice(-7);
  const convOK     = bDTI > 0 && bDTI <= 50;
  const fhaOK      = fDTI > 0 && fDTI <= 46.9 && bDTI <= 57;
  const vaOK       = bDTI > 0 && bDTI <= 55;
  const guideNote  = convOK?'meets Conventional guidelines':fhaOK?'meets FHA guidelines':vaOK?'meets VA guidelines':'subject to lender approval';

  const T  = (s:string,x:number,y:number,f:PDFFont,sz:number,c:any,mw?:number) => drawText(page,s,x,y,f,sz,c,mw);
  const HL = (x:number,y:number,w:number,c=LGRAY,sw=0.5) => page.drawLine({start:{x,y},end:{x:x+w,y},thickness:sw,color:c});
  const RX = (x:number,y:number,w:number,h:number,fill?:any,stroke?:any,sw=0.5) =>
    page.drawRectangle({x,y,width:w,height:h,color:fill,borderColor:stroke,borderWidth:stroke?sw:0});

  let y = H - M;

  // HEADER
  const HDR = 62;
  RX(0,H-HDR,W,HDR,DARK);
  T(company,M,H-24,B,18,GOLD);
  T(`AI-Powered Mortgage  |  NMLS #${coNmls}`,M,H-38,R,7.5,GRAY);
  const loLines=[{t:loName,f:B,sz:10.5,c:WHITE},{t:`Loan Officer  |  NMLS #${loNmls}`,f:R,sz:7.5,c:GRAY},{t:loPhone,f:R,sz:7.5,c:GRAY},{t:loEmail,f:R,sz:7.5,c:GRAY}];
  let loY=H-20;
  for(const l of loLines){const tw=l.f.widthOfTextAtSize(l.t,l.sz);T(l.t,W-M-tw,loY,l.f,l.sz,l.c);loY-=l.sz+3.5;}

  const banY=H-HDR;
  RX(0,banY-20,W,20,GOLD);
  const banTxt='CONDITIONAL PRE-APPROVAL LETTER';
  T(banTxt,(W-B.widthOfTextAtSize(banTxt,8.5))/2,banY-14,B,8.5,DARK);

  const datY=banY-20;
  RX(0,datY-28,W,28,BGRAY); HL(0,datY-28,W,LGRAY);
  for(const dc of [{lbl:'ISSUE DATE',val:issueDate,x:M},{lbl:'REFERENCE',val:refNum,x:W/2-30},{lbl:'VALID THROUGH',val:expiryDate,x:W-M-130}]){
    T(dc.lbl,dc.x,datY-9,R,6,GRAY); T(dc.val,dc.x,datY-20,B,8.5,DARK);
  }
  y=datY-36;

  T('APPLICANT INFORMATION',M,y,B,6.5,GOLD); HL(M,y-3,CW,GOLD,0.6); y-=14;
  const half=(CW-20)/2;
  T('PRIMARY BORROWER',M,y,R,6,GRAY); T('CO-BORROWER',M+half+20,y,R,6,GRAY); y-=12;
  T(borrower||'(Not specified)',M,y,B,12,DARK); T(coBorrower||'--',M+half+20,y,B,12,DARK); y-=13;
  T('LOAN PURPOSE',M,y,R,6,GRAY); if(cscore)T('CREDIT SCORE',M+half+20,y,R,6,GRAY); y-=11;
  T(purpose,M,y,B,10,DARK); if(cscore)T(cscore,M+half+20,y,B,10,DARK); y-=16;

  const hiTxt=`This letter confirms that ${borrower||'the applicant'}${coBorrower?' and '+coBorrower:''} ${coBorrower?'have':'has'} been conditionally pre-approved for a ${loanType} ${loanProg} mortgage in the amount of ${fmtD(loanAmt)} at an estimated rate of ${fmtP(rate)}. This pre-approval is valid through ${expiryDate} and ${guideNote}.`;
  const hiWords=hiTxt.split(' ');let hiLines=1,hiLine='';
  for(const w of hiWords){const t=hiLine?hiLine+' '+w:w;if(R.widthOfTextAtSize(t,9)>CW-18){hiLines++;hiLine=w;}else hiLine=t;}
  const hiH=hiLines*13+14;
  RX(M-3,y-hiH+5,CW+6,hiH,BGRAY); RX(M-3,y-hiH+5,3,hiH,GOLD);
  T(hiTxt,M+7,y,R,9,rgb(0.18,0.18,0.18),CW-18); y-=hiH+10;

  T('APPROVED LOAN PARAMETERS',M,y,B,6.5,GOLD); HL(M,y-3,CW,GOLD,0.6); y-=14;
  const params=[
    {lbl:'LOAN AMOUNT',val:fmtD(loanAmt)},{lbl:'LOAN TYPE',val:loanType},{lbl:'PROGRAM',val:loanProg},{lbl:'INTEREST RATE*',val:fmtP(rate)},
    {lbl:'LOAN TERM',val:`${termMo} mo`},{lbl:'LTV / CLTV',val:`${ltv.toFixed(1)}% / ${cltv.toFixed(1)}%`},
    ...(purchPrice?[{lbl:'PURCHASE PRICE',val:fmtD(purchPrice)}]:[]),
    ...(downPay?[{lbl:'DOWN PAYMENT',val:fmtD(downPay)}]:[]),
    {lbl:'OCCUPANCY',val:occ},
  ];
  const cW4=CW/4;
  for(let i=0;i<params.length;i++){
    const col=i%4; if(i>0&&col===0)y-=24; const px=M+col*cW4;
    T(params[i].lbl,px,y,R,6,GRAY);
    T(params[i].val,px,y-12,B,params[i].lbl==='LOAN AMOUNT'?12:9.5,params[i].lbl==='LOAN AMOUNT'?GOLD:DARK);
  }
  y-=24;
  if(propAddr){T('SUBJECT PROPERTY',M,y,R,6,GRAY);y-=11;T(propAddr,M,y,B,9,DARK,CW);y-=4;}
  y-=10;

  const leftW=CW*0.52,rightW=CW*0.44,gap=CW*0.04,rightX=M+leftW+gap;
  T('MONTHLY PAYMENT (PITIA)',M,y,B,6.5,GOLD); HL(M,y-3,leftW,GOLD,0.6); y-=13;
  const pitia=[
    {lbl:'Principal & Interest',val:pi},
    ...(taxes>0?[{lbl:'Property Taxes',val:taxes}]:[]),
    ...(ins>0?[{lbl:"Homeowner's Insurance",val:ins}]:[]),
    ...(mi>0?[{lbl:'Mortgage Insurance',val:mi}]:[]),
    ...(hoa>0?[{lbl:'HOA Dues',val:hoa}]:[]),
  ];
  const totalP=parseFloat(String(d.total_pitia||0))||pitia.reduce((s,r)=>s+r.val,0);
  let pyStart=y;
  for(const row of pitia){
    HL(M,y+2,leftW,LGRAY); T(row.lbl,M+6,y-7,R,8,DARK);
    const vs='$'+fmt(row.val,2),vw=B.widthOfTextAtSize(vs,8);
    T(vs,M+leftW-4-vw,y-7,B,8,DARK); y-=16;
  }
  RX(M,y-16,leftW,16,DARK);
  T('Total Monthly Payment',M+6,y-11,B,8,GOLD);
  const ts='$'+fmt(totalP,2),tw=B.widthOfTextAtSize(ts,10);
  T(ts,M+leftW-4-tw,y-11,B,10,GOLD);
  const pitiaBottom=y-16; y=pyStart;

  if(fDTI>0||bDTI>0){
    T('DTI ANALYSIS',rightX,y,B,6.5,GOLD); HL(rightX,y-3,rightW,GOLD,0.6); y-=13;
    const cardW=(rightW-6)/2;
    for(let i=0;i<2;i++){
      const cx=rightX+i*(cardW+6);
      RX(cx,y-38,cardW,38,undefined,LGRAY,0.5);
      const lbl=i===0?'FRONT DTI':'BACK DTI',val=i===0?`${fDTI.toFixed(2)}%`:`${bDTI.toFixed(2)}%`;
      T(lbl,cx+(cardW-R.widthOfTextAtSize(lbl,6))/2,y-9,R,6,GRAY);
      T(val,cx+(cardW-B.widthOfTextAtSize(val,14))/2,y-26,B,14,DARK);
    }
    y-=44;
    for(const c of [{ok:convOK,lbl:'Conv. (Back 50% max)'},{ok:fhaOK,lbl:'FHA (Front 46.9% / Back 57%)'},{ok:vaOK,lbl:'VA (Back 55% max)'}]){
      if(c.ok){page.drawLine({start:{x:rightX,y:y+1},end:{x:rightX+3,y:y-3},thickness:1.4,color:GREEN,opacity:0.9});page.drawLine({start:{x:rightX+3,y:y-3},end:{x:rightX+8,y:y+5},thickness:1.4,color:GREEN,opacity:0.9});}
      else{page.drawLine({start:{x:rightX,y:y+5},end:{x:rightX+8,y:y-1},thickness:1.4,color:RED,opacity:0.9});page.drawLine({start:{x:rightX,y:y-1},end:{x:rightX+8,y:y+5},thickness:1.4,color:RED,opacity:0.9});}
      T(c.lbl,rightX+12,y,R,7.5,DARK); y-=11;
    }
  }
  y=Math.min(y,pitiaBottom)-12;

  T('CONDITIONS & REQUIREMENTS',M,y,B,6.5,GOLD); HL(M,y-3,CW,GOLD,0.6); y-=12;
  T('Subject to, but not limited to:',M,y,I,7.5,GRAY); y-=11;
  const conds=['Satisfactory appraisal at or above purchase price','Clear title with no undisclosed liens',
    'Continued employment & income verification through closing','No material change in credit, debt, or financial position',
    'Satisfactory review of all income & asset documentation','AUS and underwriter final approval',
    "Homeowner's insurance binder prior to closing",'Rate lock confirmation prior to interest rate being final'];
  const colCondW=(CW-12)/2;
  for(let i=0;i<conds.length;i++){
    const col=i%2,cx=M+col*(colCondW+12),cy=y-Math.floor(i/2)*13;
    T(`${i+1}.`,cx,cy,B,7.5,DARK); T(conds[i],cx+13,cy,R,7.5,DARK,colCondW-16);
  }
  y-=Math.ceil(conds.length/2)*13+8;

  // SIGNATURE
  HL(M,y,CW,LGRAY); y-=8;
  if (sigFont) {
    const sigSize=30, w1=sigFont.widthOfTextAtSize('Rene',sigSize);
    page.drawText('Rene',{x:M,y:y-26,size:sigSize,font:sigFont,color:INK,opacity:0.92});
    page.drawText('Duarte',{x:M+w1+6,y:y-26,size:sigSize,font:sigFont,color:INK,opacity:0.92});
    y-=40;
  } else {
    page.drawText('Rene Duarte',{x:M,y:y-22,size:22,font:TBI,color:INK,opacity:0.88});
    page.drawLine({start:{x:M,y:y-27},end:{x:M+145,y:y-28},thickness:0.7,color:INK,opacity:0.4});
    y-=34;
  }
  HL(M,y,210,DARK,0.7); y-=7;
  T(`${loName}  -  Loan Officer  -  NMLS #${loNmls}`,M,y,R,7,GRAY); y-=11;
  T(`${company}  -  NMLS #${coNmls}  -  Licensed in California`,M,y,R,7,GRAY);

  const vbX=W-M-128,vbTop=y+40;
  RX(vbX,vbTop-42,128,42,rgb(0.04,0.15,0.04),rgb(0.09,0.38,0.18),0.5);
  T('VALID THROUGH',vbX+(128-R.widthOfTextAtSize('VALID THROUGH',6.5))/2,vbTop-12,R,6.5,GREEN);
  T(expiryDate,vbX+(128-B.widthOfTextAtSize(expiryDate,9))/2,vbTop-28,B,9,GREEN);

  // QR Code — bottom right (embedded as base64, no runtime fetch)
  try {
    const qrBytes = Uint8Array.from(atob(QR_CODE_B64), c => c.charCodeAt(0));
    const qrImg = await doc.embedPng(qrBytes);
    const qrSize = 80;
    const qrX = W - M - qrSize;
    const qrY = vbTop - 42 - qrSize - 6;
    page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });
    T('Scan to connect', qrX + (qrSize - R.widthOfTextAtSize('Scan to connect', 5.5)) / 2, qrY - 8, R, 5.5, GRAY);
  } catch (e) { console.log('[qr] embed error:', String(e).slice(0, 80)); }
  y-=18;

  // DISCLAIMER — removed "arranges but does not make loans" line per request
  HL(M,y,CW,LGRAY); y-=8;
  const disc =
    `*INTEREST RATE DISCLOSURE: The interest rate shown (${fmtP(rate)}) is a preliminary estimate provided for illustrative purposes only and does not constitute a lock, commitment, or guarantee. ` +
    `Final interest rate is subject to credit approval, market conditions at time of lock, loan program eligibility, property appraisal, and full underwriting review. ` +
    `Rates fluctuate daily and may change without notice. A rate lock must be confirmed in writing by ${brokerName} to be binding. ` +
    `BROKER DISCLOSURE: This pre-approval letter is issued by ${loName}, NMLS #${loNmls}, a licensed Mortgage Loan Originator, acting as an authorized representative of ${brokerName}, ` +
    `NMLS #${brokerNmls}, a California licensed mortgage broker (CA DRE #02075036), located at ${brokerAddr}. ` +
    `This is not a commitment to lend. Loan approval is subject to satisfactory completion of the full loan application, verification of all income, assets, employment, and credit information, ` +
    `receipt of an acceptable appraisal, clear title, and final investor approval. All loan programs, terms, and conditions are subject to change or withdrawal without notice. ` +
    `Equal Housing Lender. NMLS Consumer Access: www.nmlsconsumeraccess.org.`;
  T(disc, M, y, I, 5.5, GRAY, CW);

  return doc.save();
}
