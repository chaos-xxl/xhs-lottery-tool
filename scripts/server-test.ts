/**
 * 服务器端签名 + feed 请求测试
 */

import { getSignBrowser, closeSignBrowser } from '../lib/xhs/sign-browser';
import { SecureStore } from '../lib/config/secure-store';

const NOTE_ID = '66422a1c000000001e039684';
const XSEC_TOKEN = 'ABYokpfXOUN_mmLbXvSgX9OAcna5wuyxv4kXOaOPZko9g=';

async function main(): Promise<void> {
  // 读取存储的 Cookie
  const store = new SecureStore();
  let cookieStr: string;
  try {
    const cookie = store.getCookie();
    cookieStr = (cookie as Record<string, string>)._raw ?? Object.entries(cookie).filter(([k]) => k !== '_raw').map(([k, v]) => `${k}=${v}`).join('; ');
    console.log('Cookie 长度:', cookieStr.length);
    console.log('Cookie 前 50 字符:', cookieStr.slice(0, 50) + '...');
  } catch (e) {
    console.log('Cookie 读取失败:', (e as Error).message);
    return;
  }

  // 启动签名服务
  console.log('\n启动签名服务...');
  const signer = await getSignBrowser({ cookieString: cookieStr, headless: true });
  console.log('签名服务就绪');

  // 测试 feed 接口（POST）
  const feedUri = '/api/sns/web/v1/feed';
  const feedBody = {
    source_note_id: NOTE_ID,
    image_formats: ['jpg', 'webp', 'avif'],
    extra: { need_body_topic: 1 },
    xsec_source: 'pc_user',
    xsec_token: XSEC_TOKEN,
  };

  console.log('\n生成签名...');
  const headers = await signer.sign(feedUri, feedBody);
  console.log('x-s:', (headers['x-s'] ?? '').slice(0, 30) + '...');
  console.log('x-t:', headers['x-t']);

  console.log('\n发起 feed 请求...');
  const res = await fetch(`https://edith.xiaohongshu.com${feedUri}`, {
    method: 'POST',
    headers: {
      ...headers,
      cookie: cookieStr,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      referer: 'https://www.xiaohongshu.com/',
      origin: 'https://www.xiaohongshu.com',
      'content-type': 'application/json;charset=UTF-8',
    },
    body: JSON.stringify(feedBody),
  });

  console.log('HTTP', res.status);
  const text = await res.text();
  console.log('响应前 300 字符:', text.slice(0, 300));

  try {
    const json = JSON.parse(text);
    console.log('\nsuccess:', json.success, 'code:', json.code);
    if (json.data?.items?.[0]) {
      const n = json.data.items[0].note_card;
      console.log('title:', n?.title);
      console.log('author:', n?.user?.nickname);
    }
    if (!json.success) console.log('msg:', json.msg);
  } catch {
    console.log('JSON 解析失败');
  }

  await closeSignBrowser();
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
