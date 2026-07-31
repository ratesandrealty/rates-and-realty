import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const TOKEN_URL="https://api.cotality.com/trestle/oidc/connect/token";
const API="https://api.cotality.com/trestle/odata";
let tok:string|null=null,exp=0;
async function getToken(){
  if(tok&&Date.now()<exp)return tok;
  const id=Deno.env.get('TRESTLE_CLIENT_ID'),sec=Deno.env.get('TRESTLE_CLIENT_SECRET');
  const r=await fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:id!,client_secret:sec!,scope:'api'})});
  const d=await r.json();
  if(!d.access_token)return JSON.stringify({token_error:d});
  tok=d.access_token;exp=Date.now()+(d.expires_in-60)*1000;return tok!;
}
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info'};
Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  const token=await getToken();
  async function q(label:string,url:string){
    try{
      const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
      const d=await r.json();
      return {label,status:r.status,count:d.value?.length??0,error:d.error??d['@odata.error']??null,items:d.value?.slice(0,3)??[]};
    }catch(e:any){return {label,error:e.message};}
  }
  const base=API;
  const enc=encodeURIComponent;
  const results:any={};
  // 1. What resources/endpoints exist?
  const meta=await fetch(`${base}/$metadata`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/xml'}});
  results.metadata_status=meta.status;
  // 2. What states are available?
  results.states=await q('states_sample',`${base}/Property?$top=20&$select=StateOrProvince&$filter=${enc("StandardStatus eq 'Active'")}`);
  // 3. States unique list
  if(results.states.items){
    results.unique_states=[...new Set(results.states.items.map((x:any)=>x.StateOrProvince))];
  }
  // 4. Try other states
  results.texas=await q('texas',`${base}/Property?$top=3&$select=ListingKey,City,StateOrProvince,ListPrice&$filter=${enc("StateOrProvince eq 'TX' and StandardStatus eq 'Active'")}`);
  results.nevada=await q('nevada',`${base}/Property?$top=3&$select=ListingKey,City,StateOrProvince,ListPrice&$filter=${enc("StateOrProvince eq 'NV' and StandardStatus eq 'Active'")}`);
  results.arizona=await q('arizona',`${base}/Property?$top=3&$select=ListingKey,City,StateOrProvince,ListPrice&$filter=${enc("StateOrProvince eq 'AZ' and StandardStatus eq 'Active'")}`);
  // 5. What MLS boards/systems are available?
  const memberRes=await fetch(`${base}/Member?$top=1&$select=MemberKey,MemberMlsId,OfficeMlsId`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
  const memberData=await memberRes.json();
  results.member_access={status:memberRes.status,sample:memberData.value?.slice(0,2),error:memberData.error??null};
  // 6. Check what resources exist on the API
  const resources=await fetch(`${base}/`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
  const rData=await resources.json();
  results.available_resources=rData.value?.map((x:any)=>x.name)??[];
  // 7. Wide California sample — what counties?
  results.ca_counties=await q('ca_counties',`${base}/Property?$top=30&$select=CountyOrParish,City,StateOrProvince&$filter=${enc("StateOrProvince eq 'CA' and StandardStatus eq 'Active'")}`);
  if(results.ca_counties.items){
    const counties=[...new Set(results.ca_counties.items.map((x:any)=>x.CountyOrParish))];
    const cities=[...new Set(results.ca_counties.items.map((x:any)=>x.City))];
    results.ca_unique_counties=counties;
    results.ca_unique_cities=cities;
  }
  // 8. Rental/lease listings?
  results.rentals=await q('rentals',`${base}/Property?$top=3&$select=ListingKey,City,ListPrice,PropertyType&$filter=${enc("StandardStatus eq 'Active' and PropertyType eq 'Residential Lease'")}`);
  // 9. Commercial?
  results.commercial=await q('commercial',`${base}/Property?$top=3&$select=ListingKey,City,ListPrice,PropertyType&$filter=${enc("PropertyType eq 'Commercial Sale' and StandardStatus eq 'Active'")}`);
  // 10. Total active count for CA
  results.ca_active_total=await q('ca_total',`${base}/Property?$top=1&$count=true&$select=ListingKey&$filter=${enc("StateOrProvince eq 'CA' and StandardStatus eq 'Active'")}`);
  return new Response(JSON.stringify(results,null,2),{headers:{...cors,'Content-Type':'application/json'}});
});
