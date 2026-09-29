// Keep notification redirects explicit, matching the application's AI no-follow policy.
// Never resend credentials or SMS payloads to a provider's redirected destination.
export async function notificationFetch(fetcher,url,options={}) {
  const response=await fetcher(url,{...options,redirect:'manual'});
  if(response.status>=300&&response.status<400) {
    await response.body?.cancel();
    const error=new Error('通知接口返回重定向，未跟随或自动重发；请核对已配置的服务地址');
    error.code='NOTIFICATION_REDIRECT';error.httpStatus=response.status;throw error;
  }
  return response;
}
