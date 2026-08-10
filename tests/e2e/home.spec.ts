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

test("student signup route replaces the placeholder safely", async ({
  page,
}) => {
  await page.goto("/student/demo-session");
  await expect(
    page.getByRole("heading", { name: "Student signup" }),
  ).toBeVisible();
  await expect(page.getByText(/Placeholder/)).toHaveCount(0);
  await expect(page.getByText("demo-session")).toHaveCount(0);
});

test("staff placeholder page renders the access code", async ({ page }) => {
  await page.goto("/staff/demo-staff");
  await expect(page.getByText("demo-staff")).toBeVisible();
});

test("admin placeholder page renders", async ({ page }) => {
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Admin Dashboard" }),
  ).toBeVisible();
});
