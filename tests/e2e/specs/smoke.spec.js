import { test, expect } from "@playwright/test";

const ALICE = { username: "alice", password: "alice123" };
const BOB   = { username: "bob",   password: "bob1234"  };

async function signIn(page, user) {
  await page.goto("/login.html");
  await page.fill("#username", user.username);
  await page.fill("#password", user.password);
  await page.click("#login-btn");
  await page.waitForURL("**/index.html**");
  await page.waitForSelector("#canvas");
  // give the boot a tick to wire app + create the initial map
  await page.waitForTimeout(200);
}

test("login → add branch → reload → branch persists", async ({ page }) => {
  await signIn(page, ALICE);
  const before = await page.locator("#branches path.branch").count();
  await page.click("#btn-add-child");
  // wait for the 900ms autosave debounce + a margin
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForSelector("#canvas");
  await page.waitForTimeout(400);
  const after = await page.locator("#branches path.branch").count();
  expect(after).toBeGreaterThan(before);
});

test("signup screen is reachable and validates", async ({ page }) => {
  await page.goto("/login.html");
  await page.click("#signup-link");
  await expect(page.locator("#signup-form")).toBeVisible();
  await page.fill("#signup-name", "");
  await page.fill("#signup-email", "not-an-email");
  await page.click("#signup-btn");
  // HTML5 email validation prevents submit; the form stays visible.
  await expect(page.locator("#signup-form")).toBeVisible();
});

test("share flow: alice creates link, bob claims it", async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx   = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob   = await bobCtx.newPage();

  await signIn(alice, ALICE);
  // Wait until the autosave on alice's first newMap has actually landed,
  // otherwise btn-share opens for an unsaved map (currentMapId is still null).
  await alice.waitForFunction(() => document.getElementById("save-state")?.textContent.includes("saved"));
  // Use the new prominent toolbar share button (the drawer icon is still there).
  await alice.click("#btn-share");
  await alice.waitForSelector("#share-modal:not([hidden])");
  await alice.selectOption("#share-rights", "write");
  // Wait for the change-handler's POST to share_link to fill in the input.
  await alice.waitForFunction(
    () => /\/share\.html\?t=/.test(document.getElementById("share-link-input")?.value || ""),
    null,
    { timeout: 5000 }
  );
  const link = await alice.locator("#share-link-input").inputValue();
  expect(link).toContain("/share.html?t=");

  await signIn(bob, BOB);
  await bob.goto(link);
  await bob.waitForSelector("#share-accept-btn");
  await bob.click("#share-accept-btn");
  await bob.waitForURL("**/index.html?map=**");
  await bob.waitForSelector("#canvas");

  // bob should now have one shared map in his drawer
  await bob.click("#btn-maps");
  await bob.waitForSelector("#maps-list li.section-head");
  const sharedCount = await bob.locator("#maps-list li.section-head ~ li").count();
  expect(sharedCount).toBeGreaterThan(0);

  await aliceCtx.close();
  await bobCtx.close();
});
