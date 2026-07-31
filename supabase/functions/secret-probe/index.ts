Deno.serve(() => {
  const anon = Deno.env.get('SUPABASE_ANON_KEY') || ''
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const isJwt = (s: string) => s.startsWith('eyJ')
  return new Response(JSON.stringify({
    anon_set: !!anon, anon_is_jwt: isJwt(anon), anon_prefix: anon.slice(0, 10),
    service_set: !!service, service_is_jwt: isJwt(service), service_prefix: service.slice(0, 10),
  }), { headers: { 'Content-Type': 'application/json' } })
})