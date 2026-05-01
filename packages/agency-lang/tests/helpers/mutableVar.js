let _values = {};
export function setMutable(key, value) { _values[key] = value; }
export function getMutable(key, defaultValue) {
  if (_values[key] === undefined && defaultValue !== undefined) {
    _values[key] = defaultValue;
  }
  return _values[key];
}
export function resetMutable() { _values = {}; }
