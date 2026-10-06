export const head = (arr: any[]): any => arr[0];
export const tail = (arr: any[]): any[] => arr.slice(1);
export const empty = (arr: any[]): boolean => arr.length === 0;

export function builtinSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}
