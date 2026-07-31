import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const TOKEN_URL="https://api.cotality.com/trestle/oidc/connect/token";
const API="https://api.cotality.com/trestle/odata";
let tok:string|null=null,exp=0;
async function getToken(){
  if(tok&&Date.now()<exp)return tok;
  const id=Deno.env.get('TRESTLE_CLIENT_ID'),sec=Deno.env.get('TRESTLE_CLIENT_SECRET');
  const r=await fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:id!,client_secret:sec!,scope:'api'})});
  const d=await r.json();tok=d.access_token;exp=Date.now()+(d.expires_in-60)*1000;return tok!;
}
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info'};
Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  const token=await getToken();
  async function q(filter:string,top=5,sel='ListingKey,ListPrice,PropertyType,PropertySubType,City,StandardStatus'){
    const url=`${API}/Property?$filter=${encodeURIComponent(filter)}&$top=${top}&$select=${sel}`;
    const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
    const d=await r.json();
    return {url,count:d.value?.length??0,error:d.error??d['@odata.error']??null,items:d.value?.map((x:any)=>({key:x.ListingKey,price:x.ListPrice,type:x.PropertyType,sub:x.PropertySubType,city:x.City,status:x.StandardStatus}))};
  }
  const results:any={};

  // RENTAL DIAGNOSTICS for Rates & Realty alert: "Rentals under $4k"
  // Cities: Anaheim, Buena Park, Costa Mesa, Fountain Valley, Garden Grove, Huntington Beach, Santa Ana, Westminster
  // listing_statuses: Active, Coming Soon
  // PropertyType: ResidentialLease (forced for rent type)
  // ListPrice <= 4000, BedroomsTotal >= 2

  // r1: Exact filter that send-listing-alerts builds (full list)
  results.r1_exact_app_filter = await q(
    "(StandardStatus eq 'Active' or StandardStatus eq 'Coming Soon') and PropertyType eq 'ResidentialLease' and (City eq 'Anaheim' or City eq 'Buena Park' or City eq 'Costa Mesa' or City eq 'Fountain Valley' or City eq 'Garden Grove' or City eq 'Huntington Beach' or City eq 'Santa Ana' or City eq 'Westminster') and ListPrice le 4000 and BedroomsTotal ge 2",
    10
  );

  // r2: ANY ResidentialLease anywhere — does Trestle even have rentals?
  results.r2_any_lease = await q("PropertyType eq 'ResidentialLease'", 10);

  // r3: ResidentialLease + Active (no city filter)
  results.r3_lease_active = await q("PropertyType eq 'ResidentialLease' and StandardStatus eq 'Active'", 10);

  // r4: Single city — Huntington Beach lease
  results.r4_hb_lease = await q("City eq 'Huntington Beach' and PropertyType eq 'ResidentialLease' and StandardStatus eq 'Active'", 10);

  // r5: Garden Grove lease
  results.r5_gg_lease = await q("City eq 'Garden Grove' and PropertyType eq 'ResidentialLease' and StandardStatus eq 'Active'", 10);

  // r6: All OC counties combined, just lease + active (no price/bed filter)
  results.r6_oc_lease_active = await q(
    "PropertyType eq 'ResidentialLease' and StandardStatus eq 'Active' and (City eq 'Anaheim' or City eq 'Huntington Beach' or City eq 'Costa Mesa' or City eq 'Garden Grove' or City eq 'Santa Ana' or City eq 'Westminster' or City eq 'Buena Park' or City eq 'Fountain Valley')",
    10
  );

  // r7: With CountyOrParish field instead of City
  results.r7_county_orange = await q("PropertyType eq 'ResidentialLease' and StandardStatus eq 'Active' and CountyOrParish eq 'Orange'", 10);

  // r8: Sample of any active listings to see what PropertyType values exist
  const r8=await fetch(`${API}/Property?$top=20&$filter=${encodeURIComponent("StandardStatus eq 'Active'")}&$select=ListingKey,PropertyType,PropertySubType,City,ListPrice`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
  const d8=await r8.json();
  if(d8.value){
    const types = d8.value.map((x:any) => x.PropertyType + '/' + (x.PropertySubType || ''));
    results.r8_sample_types = [...new Set(types)];
    results.r8_sample = d8.value.slice(0,5).map((x:any)=>({type:x.PropertyType,sub:x.PropertySubType,city:x.City,price:x.ListPrice}));
  } else {
    results.r8_error = d8;
  }

  return new Response(JSON.stringify(results,null,2),{headers:{...cors,'Content-Type':'application/json'}});
});
