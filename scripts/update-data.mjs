import { mkdir, writeFile } from "node:fs/promises";

const token = process.env.TIKHUB_API_KEY;
if (!token) throw new Error("Missing TIKHUB_API_KEY repository secret");

const titleKeys = ["title","word","keyword","sentence","name","note_title","display_name","desc","description","text","content","word_name","query","challenge_name","hashtag_name","aweme_desc","video_title","item_title","caption"];
const value = (obj, keys) => {
  for (const key of keys) if (typeof obj?.[key] === "string" || typeof obj?.[key] === "number") return String(obj[key]);
  return "";
};
const collect = (input, out = []) => {
  if (Array.isArray(input)) input.forEach(x => collect(x, out));
  else if (input && typeof input === "object") {
    const title = value(input, titleKeys);
    if (title.length >= 2 && title.length <= 160) out.push(input);
    Object.values(input).forEach(x => x && typeof x === "object" && collect(x, out));
  }
  return out;
};
const deep = (input, keys) => {
  if (!input || typeof input !== "object") return "";
  const direct = value(input, keys);
  if (direct) return direct;
  for (const child of Object.values(input)) {
    const found = deep(child, keys);
    if (found) return found;
  }
  return "";
};
const searchUrl = (platform, title) => platform === "微博"
  ? `https://s.weibo.com/weibo?q=${encodeURIComponent(title)}`
  : platform === "抖音"
    ? `https://www.douyin.com/search/${encodeURIComponent(title)}`
    : `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(title)}&source=web_explore_feed`;
const itemUrl = (platform, item, title) => {
  if (platform === "小红书") {
    const noteId = deep(item, ["note_id","id"]);
    const token = deep(item, ["xsec_token","xsecToken"]);
    if (/^[a-f0-9]{24}$/i.test(noteId)) {
      const base = `https://www.xiaohongshu.com/explore/${noteId}`;
      return token ? `${base}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_search` : base;
    }
    const raw = deep(item, ["share_url","note_url","web_url","jump_url","link"]);
    if (/^https?:\/\//.test(raw)) return raw;
    return searchUrl(platform, title);
  }
  const raw = deep(item, ["share_url","note_url","web_url","jump_url","scheme","word_scheme","url","link"]);
  if (/^https?:\/\//.test(raw)) return raw;
  const id = deep(item, ["aweme_id","item_id","id"]);
  if (platform === "抖音" && id) return `https://www.douyin.com/video/${id}`;
  return searchUrl(platform, title);
};
const parseTikHub = (platform, json, limit = 20) => {
  const seen = new Set();
  return collect(json.data).filter(item => {
    const title = clean(value(item, titleKeys));
    if (!title || seen.has(title)) return false;
    seen.add(title);
    return true;
  }).slice(0, limit).map((item, index) => {
    const title = clean(value(item, titleKeys));
    return {
      platform, rank: index + 1, title,
      heat: value(item, ["hot_value","hot","hot_score","score","view_count","views","liked_count","like_count","collect_count","comment_count"]) || "实时",
      url: itemUrl(platform, item, title),
    };
  });
};
async function tikhub(platform, endpoint, limit = 20) {
  try {
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!response.ok) throw new Error(`${platform} ${response.status}`);
    const json = await response.json();
    const items = parseTikHub(platform,json,limit);
    if (!items.length) console.error(`${platform} returned no parseable items; data keys: ${Object.keys(json?.data||{}).join(",")}`);
    return items;
  } catch (error) {
    console.error(error.message);
    return [];
  }
}
async function tikhubPost(platform, endpoint, body, limit = 20) {
  try {
    const response = await fetch(endpoint, {method:"POST",headers:{Authorization:`Bearer ${token}`,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(body)});
    if (!response.ok) throw new Error(`${platform} viral ${response.status}`);
    const json = await response.json();
    const items = parseTikHub(platform,json,limit);
    if (!items.length) console.error(`${platform} viral returned no parseable items; data keys: ${Object.keys(json?.data||{}).join(",")}`);
    return items;
  } catch (error) { console.error(error.message); return []; }
}
const clean = (s = "") => s.replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g,"").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").trim();
const parseFeed = (xml, source, cat, limit = 4) => [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)].slice(0,limit).map(m => {
  const b=m[1];
  return {source,cat,title:clean(b.match(/<title>([\s\S]*?)<\/title>/)?.[1]),url:clean(b.match(/<link>([\s\S]*?)<\/link>/)?.[1]),brief:clean(b.match(/<description>([\s\S]*?)<\/description>/)?.[1]).slice(0,150)};
}).filter(x=>x.title&&x.url);
async function feed(url, source, cat, limit = 4) {
  try {
    const response = await fetch(url,{headers:{"User-Agent":"Mozilla/5.0 ZhiyaoWorkbench/1.0"}});
    if (!response.ok) throw new Error(`${source} ${response.status}`);
    const xml = await response.text();
    return parseFeed(xml,source,cat,limit);
  } catch (error) { console.error(error.message); return []; }
}
const googleNews = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
const [xhsPage1,xhsPage2,douyin,weibo,...newsGroups] = await Promise.all([
  tikhub("小红书","https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed?cursor=",20),
  tikhub("小红书","https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed?cursor=1",20),
  tikhub("抖音","https://api.tikhub.io/api/v1/douyin/billboard/fetch_hot_challenge_list?page=1&page_size=20",20),
  tikhub("微博","https://api.tikhub.io/api/v1/weibo/web_v2/fetch_hot_search_index",20),
  feed("https://www.chinadaily.com.cn/rss/china_rss.xml","中国日报","中国",4),
  feed("https://36kr.com/feed-newsflash","36氪","科技商业",4),
  feed(googleNews('"杭州日报" when:1d'),"杭州日报","杭州",3),
  feed(googleNews('"杭州本地宝" when:3d'),"杭州本地宝","杭州生活",3),
  feed(googleNews('(百度 OR 阿里巴巴 OR 腾讯) when:1d'),"BAT观察","互联网",3),
  feed("https://www.chinanews.com.cn/rss/scroll-news.xml","中国新闻网","综合",3),
]);
const seenXhs = new Set();
const xiaohongshu = [...xhsPage1,...xhsPage2].filter(x=>!seenXhs.has(x.title)&&seenXhs.add(x.title)).slice(0,20).map((x,i)=>({...x,rank:i+1}));
const xhsKeyword = xiaohongshu[0]?.title || "生活";
const [xhsViral,douyinViral,weiboViral] = await Promise.all([
  tikhub("小红书",`https://api.tikhub.io/api/v1/xiaohongshu/app_v2/search_notes?keyword=${encodeURIComponent(xhsKeyword)}&page=1&sort_type=popularity_descending&note_type=%E4%B8%8D%E9%99%90&time_filter=%E4%B8%80%E5%91%A8%E5%86%85`,20),
  tikhubPost("抖音","https://api.tikhub.io/api/v1/douyin/billboard/fetch_hot_total_video_list",{page:1,page_size:20,date_window:24,sub_type:1001,keyword:"",tags:[]},20),
  tikhub("微博","https://api.tikhub.io/api/v1/weibo/app/fetch_home_recommend_feed?page=1&count=20",20),
]);
const seenNews = new Set();
const newsItems = newsGroups.flat().filter(x=>!seenNews.has(x.title)&&seenNews.add(x.title)).slice(0,20);
const viral = [...xhsViral,...douyinViral,...weiboViral];
const payload = { fetchedAt:new Date().toISOString(), hot:[...xiaohongshu,...douyin,...weibo], viral, news:newsItems, status:{xiaohongshu:!!xiaohongshu.length,douyin:!!douyin.length,weibo:!!weibo.length,viral:!!viral.length,news:!!newsItems.length} };
await mkdir("data",{recursive:true});
await writeFile("data/live.json",JSON.stringify(payload,null,2)+"\n");
console.log(`Saved ${payload.hot.length} topics, ${payload.viral.length} viral works and ${payload.news.length} news items`);
