import type { Locator } from '@playwright/test';

/**
 * A row's menu (three dots): opened, and the item with this test id pressed in it. Every row with
 * more than one thing to do has one (reports 3aa76b, e6fc13).
 */
export async function fromRowMenu(row: Locator, menu: string, item: string): Promise<void> {
  await row.getByTestId(menu).click();
  await row.page().locator('dialog[open]').last().getByTestId(item).click();
}
