export async function callHook(args: {
  callbacks: Record<string, Function>;
  name: string;
  data: any;
}): Promise<void> {
  const { callbacks, name, data } = args;
  if (callbacks[name]) {
    await callbacks[name](data);
  }
}
