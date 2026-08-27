self.addEventListener('push', event => {
  let data={title:'KWD Rate',body:'لديك تنبيه جديد في KWD Rate',url:'/account.html'};
  try{data=event.data.json()}catch{}
  event.waitUntil(self.registration.showNotification(data.title||'KWD Rate',{body:data.body||'',icon:'/icon-192.png',badge:'/icon-192.png',data:{url:data.url||'/account.html'}}));
});
self.addEventListener('notificationclick', event => {event.notification.close();event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs)if('focus' in c)return c.focus();return clients.openWindow(event.notification.data?.url||'/account.html')}));});
