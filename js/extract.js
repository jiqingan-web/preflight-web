// extract.js — app.py 提取逻辑的忠实移植（纯函数，浏览器与 Node 共用）。
//
// 与 Python 版的对应关系：
//   extract_hints        -> extractHints(text, airports)
//   _extract_hints_core  -> extractHintsCore(text, airports)
//   extract_flights      -> extractFlights(text, upper)
//   _extract_airports    -> extractAirports(text, airports)
//   validate_date_string -> validateDateString(date)（不合法时抛 Error，消息与 Python ValueError 一致）
//   _valid_day           -> validDay(year, month, day)
//   unique               -> unique(items)
//
// Python 版每次调用都从 data/airports.json 重新读机场库；JS 版改为由调用方
// 传入 airports 数组，行为等价。

export const DATE_PATTERN = String.raw`20\d{2}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}(?:\s*日)?(?:\s*[.,./-]\s*\d{1,2})*`;

function dateRegExp() {
  return new RegExp(DATE_PATTERN, 'g');
}

export function unique(items) {
  const result = [];
  for (const item of items) {
    if (item && !result.includes(item)) result.push(item);
  }
  return result;
}

export function validDay(year, month, day) {
  // 与 Python datetime(year, month, day) 的公历校验一致。
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

const PREFIXED_FLIGHT = String.raw`(?<![A-Z0-9])([A-Z]{2}|[0-9][A-Z]|[A-Z][0-9])\s*[-\s]?\s*(\d{3,4})(?![A-Z0-9])`;

// 看起来像航班号、其实不是的东西；收割前先从文本段中抹掉。
function nonFlightPatterns() {
  return [
    // 飞机注册号：B-8875 / B8875 / B 8875。
    /(?<![A-Z0-9])B\s*-?\s*\d{4}(?![A-Z0-9])/g,
    // 飞行高度层：FL350 / FL 390。
    /(?<![A-Z0-9])FL\s*-?\s*\d{3}(?![A-Z0-9])/g,
    // 机型：A320 / A321NEO / A330-300 / B737-800 / C919 / E190。
    /(?<![A-Z0-9])(?:A3\d{2}|B7\d{2}|C9\d{2}|E1\d{2})(?:-\d{3,4})?(?:NEO|CEO)?(?!\d)/g,
    // 「机型」标签后给出的机型，如 机型：320。
    /机型\s*[:：]?\s*[A-Z]?\d{3,4}/g,
    // 美式日期（10/25/2026）：其中的 2026 不能变成航班号。
    /(?<!\d)\d{1,2}\s*[/.]\s*\d{1,2}\s*[/.]\s*\d{4}(?!\d)/g,
    // 时钟时间（08:30 / 18:13:00）。
    /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g,
  ];
}

export function extractFlights(text, upper) {
  const flights = [];

  function harvest(segment, allowPlain) {
    let cleaned = segment.toUpperCase();
    for (const pattern of nonFlightPatterns()) {
      cleaned = cleaned.replace(pattern, ' ');
    }
    cleaned = cleaned.replace(dateRegExp(), '');
    cleaned = cleaned.replace(/(?<!\d)\d{4}\s*年/g, '');
    cleaned = cleaned.replace(/(?<!\d)\d{1,2}\s*[月日]/g, '');
    const prefixed = new RegExp(PREFIXED_FLIGHT, 'g');
    for (const match of cleaned.matchAll(prefixed)) {
      flights.push(match[1].toUpperCase() + match[2]);
    }
    if (allowPlain) {
      const residual = cleaned.replace(new RegExp(PREFIXED_FLIGHT, 'g'), '');
      for (const match of residual.matchAll(/(?<!\d)\d{3,4}(?!\d)/g)) {
        flights.push(match[0]);
      }
    }
  }

  const labelled = text
    .split(/\r\n|\r|\n/)
    .filter((line) => /航班号|航班|班号|FLT|FLIGHT/i.test(line));
  if (labelled.length) {
    for (const line of labelled) harvest(line, true);
  } else {
    harvest(upper, false);
  }
  return flights;
}

export function extractAirports(text, airports) {
  // 文本中出现的机场 id，按首次出现顺序排列。
  const upper = text.toUpperCase();
  const airportMatches = [];
  airports.forEach((item, order) => {
    const needles = [item.icao || '', item.name || '', item.short_name || ''];
    needles.push(...(item.aliases || []));
    const hits = [];
    for (const needle of needles) {
      if (!needle) continue;
      const pos = upper.indexOf(needle.toUpperCase());
      if (pos !== -1) hits.push([pos, needle.length]);
    }
    if (hits.length) {
      const firstPos = Math.min(...hits.map((hit) => hit[0]));
      const longest = Math.max(...hits.filter((hit) => hit[0] === firstPos).map((hit) => hit[1]));
      airportMatches.push({
        pos: firstPos,
        negLength: -longest,
        order,
        id: item.id,
        icao: item.icao || '',
      });
    }
  });
  // 按首次出现排序（同一位置取最长匹配），然后去重：同一 ICAO 只能出一个
  // 机场；被更长匹配完全包含的短名（如「盐城南洋」里的「盐城」）不是独立机场。
  airportMatches.sort((a, b) => a.pos - b.pos || a.negLength - b.negLength || a.order - b.order);
  const result = [];
  const seenIcao = new Set();
  const keptSpans = [];
  for (const match of airportMatches) {
    const length = -match.negLength;
    if (match.icao && seenIcao.has(match.icao)) continue;
    const contained = keptSpans.some(
      ([keptPos, keptLen]) => keptPos <= match.pos && match.pos + length <= keptPos + keptLen && keptLen > length,
    );
    if (contained) continue;
    if (match.icao) seenIcao.add(match.icao);
    keptSpans.push([match.pos, length]);
    result.push(match.id);
  }
  return result;
}

export function extractHintsCore(text, airports) {
  // 原始的整段文本提取：合并的日期 / 航班 / 机场。
  const upper = text.toUpperCase();
  const foundAirports = extractAirports(text, airports);

  const groupedDates = new Map();
  function addDay(year, month, day) {
    // 真实日历校验：13月40日 / 2月30日 直接丢弃，不写入生成的文档。
    if (!validDay(year, month, day)) return;
    const key = `${year}-${month}`;
    if (!groupedDates.has(key)) groupedDates.set(key, { year, month, days: [] });
    groupedDates.get(key).days.push(day);
  }

  const fullMatches = [...text.matchAll(dateRegExp())];
  for (const match of fullMatches) {
    const numbers = (match[0].match(/\d+/g) || []).map((value) => parseInt(value, 10));
    if (numbers.length >= 3) {
      const [year, month, ...days] = numbers;
      for (const day of days) addDay(year, month, day);
    }
  }
  // 无年份的「月/日」模式（年份取当前年）。它们在所有完整日期被抹掉后的
  // 文本上运行，因此 2027年1月5日 不会再派生出一个当前年的副本（1月5日）。
  let masked = '';
  let lastIndex = 0;
  for (const match of fullMatches) {
    masked += text.slice(lastIndex, match.index) + ' '.repeat(match[0].length);
    lastIndex = match.index + match[0].length;
  }
  masked += text.slice(lastIndex);
  const fallbackYear = new Date().getFullYear();
  for (const match of masked.matchAll(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日?(?!\d)/g)) {
    addDay(fallbackYear, parseInt(match[1], 10), parseInt(match[2], 10));
  }
  for (const match of masked.matchAll(/(?<!\d)(\d{1,2})\s*[,，]\s*(\d{1,2})\s*月(?!\d)/g)) {
    addDay(fallbackYear, parseInt(match[2], 10), parseInt(match[1], 10));
  }
  const dateParts = [];
  for (const { year, month, days } of groupedDates.values()) {
    const validDays = unique(days);
    if (validDays.length) dateParts.push(`${year}.${month}.` + validDays.join('.'));
  }
  const date = dateParts.join('、');

  const flights = extractFlights(text, upper);
  return { date, flights: unique(flights).join('、'), airport_ids: foundAirports };
}

export function extractHints(text, airports) {
  // 飞行准备网页面：每个任务一个块、以「航班日期」开头。第一个块以上的
  // 内容（如带自己日期的「最近经历」页眉）不是航班日期，不能漏进结果；
  // 每个块也独立成组：合并视图保持原样（多日行程仍是一份文档），界面上
  // 还可以让用户改选单个任务。
  const anchorPattern = /航班日期\s*[:：]?\s*(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/g;
  const anchors = [...text.matchAll(anchorPattern)].filter((match) =>
    validDay(parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)),
  );
  if (!anchors.length) {
    const hints = extractHintsCore(text, airports);
    hints.groups = [];
    return hints;
  }

  const merged = extractHintsCore(text.slice(anchors[0].index), airports);
  const groups = [];
  anchors.forEach((anchor, index) => {
    const start = anchor.index;
    let end = index + 1 < anchors.length ? anchors[index + 1].index : text.length;
    // 一个块自身的字段到它的「电子任务书」行为止；下一任务的标题行位于
    // 该行与下一个「航班日期」锚点之间，不属于任何一块的字段。
    const blockEnd = /电子任务书[^\n]*/.exec(text.slice(start, end));
    if (blockEnd) end = start + blockEnd.index + blockEnd[0].length;
    const segment = text.slice(start, end);
    const group = {
      date: `${parseInt(anchor[1], 10)}.${parseInt(anchor[2], 10)}.${parseInt(anchor[3], 10)}`,
      flights: unique(extractFlights(segment, segment.toUpperCase())).join('、'),
      airport_ids: extractAirports(segment, airports),
    };
    if (groups.length && groups[groups.length - 1].date === group.date) {
      const previous = groups[groups.length - 1];
      previous.flights = unique([...previous.flights.split('、'), ...group.flights.split('、')]).join('、');
      previous.airport_ids = unique([...previous.airport_ids, ...group.airport_ids]);
    } else {
      groups.push(group);
    }
  });
  merged.groups = groups;
  return merged;
}

export function validateDateString(date) {
  // 校验（可多日的）日期字符串是否符合真实日历。接受 extractHints 产出的
  // 点分形式，如 "2026.10.25" 或 "2026.10.26.27.28"，多段以 、 连接。
  // 不可能的日期（如 2026.13.40 / 2026.2.30）抛错，消息与 Python 版一致。
  for (const rawPart of String(date).split(/[、,，;；]/)) {
    const part = rawPart.trim();
    if (!part) continue;
    const numbers = (part.match(/\d+/g) || []).map((value) => parseInt(value, 10));
    if (numbers.length < 3 || !(1000 <= numbers[0] && numbers[0] <= 9999)) {
      throw new Error(`日期格式不正确：${part}（请用如 2026.10.25 的格式）`);
    }
    const [year, month, ...days] = numbers;
    for (const day of days) {
      if (!validDay(year, month, day)) {
        throw new Error(`日期不存在：${year}年${month}月${day}日`);
      }
    }
  }
}
