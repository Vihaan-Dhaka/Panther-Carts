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

test("student signup rejects an invalid session link safely", async ({
  page,
}) => {
  await page.goto("/student/demo-session");
  await expect(
    page.getByRole("heading", { name: "Student signup" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Signup unavailable" }),
  ).toBeVisible();
  await expect(page.getByText(/This signup link is invalid\./)).toBeVisible();
  await expect(page.getByText("demo-session")).toHaveCount(0);
});

test("staff station rejects an invalid access link safely", async ({
  page,
}) => {
  await page.goto("/staff/demo-staff");
  await expect(
    page.getByRole("heading", { name: "Staff station unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText(/This staff station link is invalid\./),
  ).toBeVisible();
  await expect(page.getByText("demo-staff")).toHaveCount(0);
});

test("admin dashboard renders", async ({ page }) => {
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Admin Dashboard" }),
  ).toBeVisible();
});
