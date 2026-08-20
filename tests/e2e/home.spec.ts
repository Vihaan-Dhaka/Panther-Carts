import { expect, test } from "@playwright/test";

test("homepage links to the three interfaces", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Panther Carts" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Student/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Staff/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Admin/ })).toBeVisible();
});

test("staff access validates a malformed manual code before exchange", async ({
  page,
}) => {
  await page.goto("/staff");
  await expect(
    page.getByRole("heading", { name: "Staff access" }),
  ).toBeVisible();
  await page.getByLabel("Staff access code").fill("12");
  await page.getByRole("button", { name: "Open staff station" }).click();
  await expect(
    page.getByText("Enter the eight-digit staff access code"),
  ).toBeVisible();
});

test("admin dashboard requires authentication", async ({ page }) => {
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Admin sign in" }),
  ).toBeVisible();
  await expect(page.getByLabel("Admin email")).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveAttribute("type", "password");
  await expect(page).toHaveURL(/\/admin\/login$/);
  const headers = await page.request.get("/admin/login");
  expect(headers.headers()["cache-control"]).toMatch(/no-store|no-cache/);
  expect(headers.headers()["referrer-policy"]).toBe("no-referrer");
});
