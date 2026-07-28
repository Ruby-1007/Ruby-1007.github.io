import { mkdir, readFile, writeFile } from "node:fs/promises";

const token = process.env.TIKHUB_API_KEY;
if (!token) throw new Error("Missing TIKHUB_API_KEY repository secret");

const titleKeys = ["title","word","keyword","sentence","name","note_title","display_name","desc","description","text","content","word_name","query","challenge_name","hashtag_name","aweme_desc","video_title","item_title","caption","hot_sentence","sentence_name","sentence_text","hot_word","topic_name"];
const value = (obj, keys) => {
  for (const key of keys) if (typeof obj?.[key] === "string" || typeof obj?.[key] === "number") return String(obj[key]);
  return "";
};
const collect = (input, out = []) => {
  if (Array.isArray(input)) input.forEach(x => collect(x, out));
  else if (typeof input === "string" && /^[\[{]/.test(input.trim())) {
    try { collect(JSON.parse(input), out); } catch {}
  }
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
    const raw = deep(item, ["share_url","note_url","web_url","jump_url","link"]);
    if (/^https?:\/\//.test(raw)) return raw;
    const noteId = deep(item, ["note_id","id"]);
    const token = deep(item, ["xsec_token","xsecToken"]);
    if (/^[a-f0-9]{24}$/i.test(noteId)) {
      const base = `https://www.xiaohongshu.com/explore/${noteId}`;
      return token ? `${base}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_search&source=web_search_result_notes` : searchUrl(platform,title);
    }
    return searchUrl(platform, title);
  }
  const raw = deep(item, ["share_url","note_url","web_url","jump_url","scheme","word_scheme","url","link"]);
  if (/^https?:\/\//.test(raw)) return raw;
  const id = deep(item, ["aweme_id","item_id","id"]);
  if (platform === "抖音" && id) return `https://www.douyin.com/video/${id}`;
  return searchUrl(platform, title);
};
const parseTikHub = (platform, json, limit = 20, directOnly = false) => {
  const seen = new Set();
  return collect(json.data).filter(item => {
    const title = clean(value(item, titleKeys));
    if (!title || seen.has(title)) return false;
    seen.add(title);
    return true;
  }).map(item => {
    const title = clean(value(item, titleKeys));
    const likes = Number(deep(item,["liked_count","like_count","likes"])||0);
    const collects = Number(deep(item,["collected_count","collect_count","collects"])||0);
    const comments = Number(deep(item,["comment_count","comments"])||0);
    const shares = Number(deep(item,["share_count","shares"])||0);
    const views = Number(deep(item,["view_count","views","play_count"])||0);
    return {
      platform, title,
      heat: deep(item, ["hot_value","hot","hot_score","score","view_count","views","liked_count","like_count","collect_count","comment_count"]) || "实时",
      metrics:{likes,collects,comments,shares,views},
      engagement:likes+collects*1.5+comments*2+shares*2,
      url: itemUrl(platform, item, title),
    };
  }).filter(item => !directOnly || (
    platform === "小红书" ? /xiaohongshu\.com\/explore\/[a-f0-9]{24}.+xsec_token=/i.test(item.url) :
    platform === "抖音" ? /douyin\.com\/video\/\d+/.test(item.url) :
    /weibo\.com\/.+\/[A-Za-z0-9]+/.test(item.url)
  )).slice(0, limit).map((item,index)=>({...item,rank:index+1}));
};
async function tikhub(platform, endpoint, limit = 20, directOnly = false) {
  try {
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g," ").slice(0,500);
      throw new Error(`${platform} ${response.status}: ${detail}`);
    }
    const json = await response.json();
    const items = parseTikHub(platform,json,limit,directOnly);
    if (!items.length) {
      const nestedKeys = new Set();
      const inspectKeys = (input, depth = 0) => {
        if (!input || typeof input !== "object" || depth > 5) return;
        if (Array.isArray(input)) input.slice(0,3).forEach(x => inspectKeys(x,depth+1));
        else {
          Object.keys(input).forEach(key => nestedKeys.add(key));
          Object.values(input).forEach(x => inspectKeys(x,depth+1));
        }
      };
      inspectKeys(json?.data);
      console.error(`${platform} returned no parseable items; nested keys: ${[...nestedKeys].slice(0,80).join(",")}`);
    }
    return items;
  } catch (error) {
    console.error(error.message);
    return [];
  }
}
async function tikhubPost(platform, endpoint, body, limit = 20, directOnly = false) {
  try {
    const response = await fetch(endpoint, {method:"POST",headers:{Authorization:`Bearer ${token}`,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(body)});
    if (!response.ok) throw new Error(`${platform} viral ${response.status}`);
    const json = await response.json();
    const items = parseTikHub(platform,json,limit,directOnly);
    if (!items.length) console.error(`${platform} viral returned no parseable items; data keys: ${Object.keys(json?.data||{}).join(",")}`);
    return items;
  } catch (error) { console.error(error.message); return []; }
}
async function douyinOfficialHot() {
  try {
    const response = await fetch("https://www.iesdouyin.com/aweme/v1/hot/search/list/", {
      headers: {"User-Agent":"Mozilla/5.0 ZhiyaoWorkbench/1.0",Accept:"application/json"},
    });
    if (!response.ok) throw new Error(`抖音官方热点榜 ${response.status}`);
    const json = await response.json();
    if (json.status_code !== 0 || !Array.isArray(json.data?.word_list)) throw new Error("抖音官方热点榜响应异常");
    return json.data.word_list.slice().sort((a,b)=>(a.position||99)-(b.position||99)).slice(0,50).map((item,index)=>({
      platform:"抖音",
      title:clean(item.word),
      heat:String(item.hot_value||"实时"),
      metrics:{likes:0,collects:0,comments:0,shares:0,views:0},
      engagement:0,
      url:searchUrl("抖音",clean(item.word)),
      rank:index+1,
    })).filter(item=>item.title);
  } catch (error) { console.error(error.message); return []; }
}
const clean = (s = "") => s.replace(/<!\[CDATA\[|\]\]>/g,"")
  .replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
  .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/<[^>]+>/g,"")
  .replace(/&nbsp;/gi," ").replace(/\s+/g," ").trim();
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
let previous = {};
try { previous = JSON.parse(await readFile("data/live.json","utf8")); } catch {}
const previousPlatform = platform => (previous.hot||[]).filter(x=>x.platform===platform);
const weiboFallbackTitles = [
  "习近平同卢拉通电话",
  "东野圭吾去世",
  "东野圭吾代表作",
  "大国重器解锁中国科创新高度",
  "东野圭吾 大肠癌",
  "发现好多大学生不懂邮件礼仪",
  "有微信之前人是可以不用一直在线的",
  "男子造谣松江九亭发生命案被行拘",
  "发现朋友圈没人晒旅游照了",
  "白鹿欢娱分手戏 朝玉阶",
  "那英吐槽冉莹颖败家",
  "Bin BLG",
];
const weiboFallback = weiboFallbackTitles.map((title,index)=>({
  platform:"微博",
  title,
  heat:"实时",
  rank:index+1,
  url:searchUrl("微博",title),
}));
// 每 4 小时运行的轻量模式：只更新抖音热点榜，不重复调用其他平台接口。
if (process.env.UPDATE_SCOPE === "douyin-hot") {
  const latestDouyinHot = await douyinOfficialHot();
  if (!latestDouyinHot.length) {
    throw new Error("抖音官方页面尚未返回热点榜，保留线上旧数据");
  }
  const preserved = (previous.hot||[]).filter(x=>!(x.platform==="抖音"&&x.board==="热点榜"));
  const ranked = latestDouyinHot.map((x,index)=>({...x,board:"热点榜",rank:index+1}));
  const payload = {
    ...previous,
    fetchedAt:new Date().toISOString(),
    hot:[...preserved,...ranked],
    status:{...(previous.status||{}),douyin:true},
  };
  await mkdir("data",{recursive:true});
  await writeFile("data/live.json",JSON.stringify(payload,null,2)+"\n");
  console.log(`Saved ${ranked.length} fresh Douyin hot topics`);
  process.exit(0);
}

const [xhsPage1,xhsPage2,xhsPage3,douyinHot,douyinChallenge,weiboApp,weiboSummary,weiboIndex,weiboWeb,...newsGroups] = await Promise.all([
  tikhub("小红书","https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed?cursor=0",20),
  tikhub("小红书","https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed?cursor=1",20),
  tikhub("小红书","https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed?cursor=2",20),
  douyinOfficialHot(),
  tikhub("抖音","https://api.tikhub.io/api/v1/douyin/billboard/fetch_hot_challenge_list?page=1&page_size=50",50),
  tikhub("微博","https://api.tikhub.io/api/v1/weibo/app/fetch_hot_search?category=realtimehot&page=1&count=50&region_name=%E5%8C%97%E4%BA%AC",50),
  tikhub("微博","https://api.tikhub.io/api/v1/weibo/web_v2/fetch_hot_search_summary",50),
  tikhub("微博","https://api.tikhub.io/api/v1/weibo/web_v2/fetch_hot_search_index",50),
  tikhub("微博","https://api.tikhub.io/api/v1/weibo/web/fetch_hot_search",50),
  feed("https://www.chinadaily.com.cn/rss/china_rss.xml","中国日报","中国",4),
  feed("https://36kr.com/feed-newsflash","36氪","科技商业",4),
  feed(googleNews('"杭州日报" when:1d'),"杭州日报","杭州",3),
  feed(googleNews('"杭州本地宝" when:3d'),"杭州本地宝","杭州生活",3),
  feed(googleNews('(百度 OR 阿里巴巴 OR 腾讯) when:1d'),"BAT观察","互联网",3),
  feed("https://www.chinanews.com.cn/rss/scroll-news.xml","中国新闻网","综合",3),
]);
const seenXhs = new Set();
const xiaohongshu = [...xhsPage1,...xhsPage2,...xhsPage3].filter(x=>!seenXhs.has(x.title)&&seenXhs.add(x.title)).slice(0,50).map((x,i)=>({...x,rank:i+1}));
const freshDouyinHot = douyinHot.length ? douyinHot : previousPlatform("抖音").filter(x=>x.board==="热点榜");
const freshDouyinChallenge = douyinChallenge.length ? douyinChallenge : previousPlatform("抖音").filter(x=>x.board==="挑战榜");
const freshXiaohongshu = xiaohongshu.length ? xiaohongshu : previousPlatform("小红书");
const freshWeibo = weiboApp.length ? weiboApp : weiboSummary.length ? weiboSummary : weiboIndex.length ? weiboIndex : weiboWeb.length ? weiboWeb : previousPlatform("微博").length ? previousPlatform("微博") : weiboFallback;
const douyinHotRanked = freshDouyinHot.map((x,i)=>({...x,board:"热点榜",rank:i+1}));
const douyinChallengeRanked = freshDouyinChallenge.map((x,i)=>({...x,board:"挑战榜",rank:i+1}));
const xhsKeywords = [...new Set(xiaohongshu.slice(0,3).map(x=>x.title))];
if (!xhsKeywords.length) xhsKeywords.push("生活","职场","成长");
const [xhsIdeaGroups,douyinViral] = await Promise.all([
  Promise.all(xhsKeywords.map(keyword=>tikhub("小红书",`https://api.tikhub.io/api/v1/xiaohongshu/app_v2/search_notes?keyword=${encodeURIComponent(keyword)}&page=1&sort_type=popularity_descending&note_type=%E4%B8%8D%E9%99%90&time_filter=%E4%B8%80%E5%91%A8%E5%86%85`,20,true))),
  tikhubPost("抖音","https://api.tikhub.io/api/v1/douyin/billboard/fetch_hot_total_video_list",{page:1,page_size:20,date_window:24,sub_type:1001,keyword:"",tags:[]},20,true),
]);
const seenXhsIdeas = new Set();
const xhsIdeas = freshXiaohongshu.filter(x=>!seenXhsIdeas.has(x.title)&&seenXhsIdeas.add(x.title)).slice(0,50).map((x,i)=>({...x,rank:i+1}));
const xhsViral = xhsIdeaGroups[0]||[];
const seenNews = new Set();
const newsItems = newsGroups.flat().filter(x=>!seenNews.has(x.title)&&seenNews.add(x.title)).slice(0,20);
const rankedXhsViral = [...xhsViral].sort((a,b)=>b.engagement-a.engagement).map((x,i)=>({...x,rank:i+1,rankingBasis:"一周内按点赞与互动筛选"}));
const viral = [...rankedXhsViral,...douyinViral];
const payload = { fetchedAt:new Date().toISOString(), hot:[...xhsIdeas,...douyinHotRanked,...douyinChallengeRanked,...freshWeibo.map((x,i)=>({...x,rank:i+1}))], viral, news:newsItems, status:{xiaohongshu:!!xhsIdeas.length,douyin:!!(douyinHotRanked.length||douyinChallengeRanked.length),weibo:!!freshWeibo.length,viral:!!viral.length,news:!!newsItems.length} };
await mkdir("data",{recursive:true});
await writeFile("data/live.json",JSON.stringify(payload,null,2)+"\n");
console.log(`Saved ${payload.hot.length} topics, ${payload.viral.length} viral works and ${payload.news.length} news items`);
