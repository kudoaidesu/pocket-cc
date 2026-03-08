/**
 * Push通知クライアント
 *
 * Service Worker登録、Push購読、購読情報のサーバー送信を管理する。
 */

/** Service Workerを登録し、registration を返す */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null
  try {
    const registration = await navigator.serviceWorker.register('/sw.js')
    // アクティブになるまで待つ（最大10秒）
    if (!registration.active) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SW activation timeout')), 10000)
        const sw = registration.installing || registration.waiting
        if (!sw) { clearTimeout(timeout); resolve(); return }
        sw.addEventListener('statechange', function handler() {
          if (sw.state === 'activated') { clearTimeout(timeout); sw.removeEventListener('statechange', handler); resolve() }
          if (sw.state === 'redundant') { clearTimeout(timeout); sw.removeEventListener('statechange', handler); reject(new Error('SW became redundant')) }
        })
      })
    }
    return registration
  } catch (e) {
    console.error('Service Worker registration failed:', e)
    return null
  }
}

/** Push通知がサポートされているか */
function isPushSupported() {
  return 'PushManager' in window && 'serviceWorker' in navigator && 'Notification' in window
}

/** SW registration を取得（登録済み or 新規登録） */
async function getSwRegistration() {
  const existing = await navigator.serviceWorker.getRegistration('/')
  if (existing?.active) return existing
  return await registerServiceWorker()
}

/** 現在のPush購読状態を取得 */
async function getPushSubscription() {
  if (!isPushSupported()) return null
  const reg = await getSwRegistration()
  if (!reg) return null
  return reg.pushManager.getSubscription()
}

/** Push通知を購読 */
async function subscribePush() {
  if (!isPushSupported()) {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
    if (isIOS) {
      throw new Error('iOSでプッシュ通知を使うには、Safariの共有ボタン(↑)→「ホーム画面に追加」してから開いてください')
    }
    throw new Error('このブラウザはプッシュ通知に対応していません')
  }

  // 通知権限をリクエスト
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('通知の許可が拒否されました')
  }

  // VAPID公開鍵を取得
  const res = await fetch('/api/push/vapid-public-key')
  const { publicKey } = await res.json()
  if (!publicKey) {
    throw new Error('VAPID public key not available')
  }

  // Push購読
  const registration = await getSwRegistration()
  if (!registration) throw new Error('Service Worker の登録に失敗しました。ページを再読み込みしてください')
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  })

  // サーバーに購読情報を送信
  const subJson = subscription.toJSON()
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: subJson.endpoint,
      keys: {
        p256dh: subJson.keys.p256dh,
        auth: subJson.keys.auth,
      },
    }),
  })

  return subscription
}

/** Push通知の購読を解除 */
async function unsubscribePush() {
  const subscription = await getPushSubscription()
  if (!subscription) return

  // サーバーから削除
  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  })

  // ブラウザ側の購読解除
  await subscription.unsubscribe()
}

/** Base64URL → Uint8Array 変換 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

/** Push購読ボタンの状態を更新 */
async function updatePushButton(btn) {
  if (!isPushSupported()) {
    btn.style.display = 'none'
    return
  }

  const subscription = await getPushSubscription()
  if (subscription) {
    btn.textContent = '通知ON（タップで解除）'
    btn.classList.add('active')
  } else {
    btn.textContent = '通知をONにする'
    btn.classList.remove('active')
  }
}

/** Push購読ボタンのクリックハンドラ */
async function togglePush(btn) {
  const original = btn.textContent
  btn.textContent = '処理中...'
  btn.disabled = true
  try {
    const subscription = await getPushSubscription()
    if (subscription) {
      await unsubscribePush()
    } else {
      await subscribePush()
    }
    await updatePushButton(btn)
  } catch (e) {
    console.error('Push toggle failed:', e)
    btn.textContent = original
    alert(e.message)
  } finally {
    btn.disabled = false
  }
}
