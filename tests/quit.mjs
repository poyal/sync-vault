export async function closeApp(app) {
  const pid = await app.evaluate(() => process.pid);
  let timer;
  try {
    await Promise.race([app.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("QA 앱이 10초 안에 종료되지 않았습니다.")), 10000);
    })]);
  } catch (error) {
    if (app.process().exitCode === null) {
      try { process.kill(pid); } catch (killError) { if (killError.code !== "ESRCH") throw killError; }
    }
    throw error;
  } finally { clearTimeout(timer); }
}
