// 件数に上限のある覚え書き。上限を超えたら、いちばん古く入れたものから捨てる
export function remember(map, key, value, max) {
  if (!map.has(key) && map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
  return value;
}
