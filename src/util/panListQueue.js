// A queue for actual list jobs, shared by all callers in this Runner.
// No response cache and no limit shared between different providers.
const tails = new Map();

export async function runPanListTask(provider, task) {
    const previous = tails.get(provider) || Promise.resolve();
    let release;
    const done = new Promise(resolve => { release = resolve; });
    tails.set(provider, done);
    await previous;
    try {
        return await task();
    } finally {
        release();
        if (tails.get(provider) === done) tails.delete(provider);
    }
}

export const serialPanListHandler = (provider, handler) => function (...args) {
    return runPanListTask(provider, () => handler.apply(this, args));
};
