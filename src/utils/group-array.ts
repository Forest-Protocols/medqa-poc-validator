/**
 * Groups an array of items into different fields of an object by the given key function
 * @param array - The array to group.
 * @param key - The function to get the key from each item.
 * @returns A record of keys and their corresponding items.
 */
export function groupArray<T>(array: T[], key: (item: T) => string) {
  const grouped: Record<string, T[]> = {};
  for (const item of array) {
    const k = key(item);
    if (grouped[k] === undefined) {
      grouped[k] = [];
    }
    grouped[k].push(item);
  }
  return grouped;
}
