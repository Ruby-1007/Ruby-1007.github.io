import { mkdir, writeFile } from "node:fs/promises";

const token = process.env.TIKHUB_API_KEY;
if (!token) throw new Error("Missing TIKHUB_API_KEY repository secret");

const titleKeys = ["title","word","keyword","sentence","name","note_title","display_name","desc","word_name","query"];
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
  const raw = deep(item, ["share_url","note_url","web_url","jump_url","scheme","word_scheme","url","link"]);
  if (/^https?:\/\//.test(raw)) return raw;
  const id = deep(item, ["note_id","aweme_id","item_id","id"]);
  if (platform === "抖音" && id) return `https://www.douyin.com/video/${id}`;
  if (platform === "小红书" && id) return `https://www.xiaohongshu.com/explore/${id}`;
  return searchUrl(platform, title);
};
async function tikhub(platform, endpoint) {
  try {
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!response.ok) throw new Error(`${platform} ${response.status}`);
    const json = await response.json();
    const seen = new Set();
    return collect(json.data).filter(item => {
      const title = value(item, titleKeys);
      if (!title || seen.has(title)) return false;
      seen.add(title);
      return true;
    }).slice(0, 10).map((item, index) => {
      const title = value(item, titleKeys);
      return {
        platform, rank: index + 1, title,
        heat: value(item, ["hot_value","hot","hot_score","score","view_count","views","liked_count"]) || "实时",
        url: itemUrl(platform, item, title),
      };
    });
  } catch (error) {
    console.error(error.message);
    return [];
  }
}
const clean = (s = "") => s.replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g,"").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").trim();
async function news() {
  try {
    const response = await fetch("https://www.chinanews.com.cn/rss/scroll-news.xml");
    const xml = await response.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,8).map((m,i) => {
      const b=m[1];
      return {cat:["要闻","社会","世界","文化"][i%4],title:clean(b.match(/<title>([\s\S]*?)<\/title>/)?.[1]),url:clean(b.match(/<link>([\s\S]*?)<\/link>/)?.[1]),brief:clean(b.match(/<description>([\s\S]*?)<\/description>/)?.[1]).slice(0,130)};
    }).filter(x=>x.title&&x.url);
  } catch { return []; }
}
const [xiaohongshu,douyin,weibo,newsItems] = await Promise.all([
  tikhub("小红书","https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed?cursor="),
  tikhub("抖音","https://api.tikhub.io/api/v1/douyin/billboard/fetch_hot_total_list?page=1&page_size=10"),
  tikhub("微博","https://api.tikhub.io/api/v1/weibo/web_v2/fetch_hot_search_index"),
  news(),
]);
const payload = { fetchedAt:new Date().toISOString(), hot:[...xiaohongshu,...douyin,...weibo], news:newsItems, status:{xiaohongshu:!!xiaohongshu.length,douyin:!!douyin.length,weibo:!!weibo.length,news:!!newsItems.length} };
await mkdir("data",{recursive:true});
await writeFile("data/live.json",JSON.stringify(payload,null,2)+"\n");
console.log(`Saved ${payload.hot.length} topics and ${payload.news.length} news items`);
