export async function selectBookingWorker(page, appointment, desiredWorker) {
  const search = appointment.locator('input[placeholder="Select Fieldworker"]').first();
  await search.waitFor({state:'visible',timeout:10000});
  await search.fill(desiredWorker);
  const deadline = Date.now()+12000;
  while (Date.now()<deadline) {
    await page.waitForTimeout(300);
    const candidates = [
      page.locator('[role="option"]:visible, .vs__dropdown-option:visible').filter({hasText:desiredWorker}).last(),
      page.locator('li:visible').filter({hasText:desiredWorker}).last(),
      page.getByText(desiredWorker,{exact:true}).last()
    ];
    for (const candidate of candidates) {
      if (!await candidate.isVisible().catch(()=>false)) continue;
      const text = (await candidate.innerText({timeout:500}).catch(()=>'')).replace(/\s+/g,' ').trim();
      if (!text || text.length>300 || !text.toLowerCase().includes(desiredWorker.toLowerCase())) continue;
      try { await candidate.click({force:true,timeout:1500}); }
      catch { continue; }
      // The search disappears on selection. Never wait on that old input again.
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
      return;
    }
  }
  throw new Error(`FIELDWORKER_OPTION_NOT_FOUND: ${desiredWorker}`);
}
