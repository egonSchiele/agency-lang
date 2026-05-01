export function tryMutateProperty(obj, key, value) {
  try {
    obj[key] = value;
    return false; // mutation succeeded (not frozen)
  } catch (e) {
    return true; // mutation threw (frozen)
  }
}
