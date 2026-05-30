import { test, expect } from '@playwright/test';
import path from 'path';

const harnessUrl = (scenario = 'bridges') =>
	'file://' + path.resolve('test/harness/index.html') + `?scenario=${scenario}`;

test.describe('Vault Bridges UI', () => {
	test('settings with bridges', async ({ page }) => {
		await page.setViewportSize({ width: 860, height: 620 });
		await page.goto(harnessUrl('bridges'));
		await page.waitForSelector('.setting-item');
		await page.waitForTimeout(300);
		await expect(page).toHaveScreenshot('settings-bridges.png', { fullPage: true });
	});

	test('empty state', async ({ page }) => {
		await page.setViewportSize({ width: 860, height: 620 });
		await page.goto(harnessUrl('empty'));
		await page.waitForSelector('.vault-bridges-empty');
		await page.waitForTimeout(200);
		await expect(page).toHaveScreenshot('settings-empty.png', { fullPage: true });
	});

	test('add bridge modal', async ({ page }) => {
		await page.setViewportSize({ width: 860, height: 620 });
		await page.goto(harnessUrl('bridges'));
		await page.waitForSelector('.setting-item');
		await page.waitForTimeout(200);

		// Click the "+ Add Bridge" button
		await page.getByText('+ Add Bridge').click();
		await page.waitForSelector('.modal-container');
		await page.waitForTimeout(150);

		// Fill in the form to make it look realistic
		await page.locator('.modal-container input[type=text]').nth(0).fill('My Project ADRs');
		await page.locator('.modal-container input[type=text]').nth(1).fill('/Users/you/projects/my-app');
		await page.locator('.modal-container input[type=text]').nth(2).fill('docs/adr');
		await page.locator('.modal-container input[type=text]').nth(3).fill('Projects/My App/ADRs');

		await page.waitForTimeout(150);
		await expect(page).toHaveScreenshot('add-bridge-modal.png', { fullPage: true });
	});

	test('Claude integration settings', async ({ page }) => {
		await page.setViewportSize({ width: 860, height: 760 });
		await page.goto(harnessUrl('bridges'));
		await page.waitForSelector('.setting-item');
		await page.waitForTimeout(300);
		await expect(page).toHaveScreenshot('settings-claude-integration.png', { fullPage: true });
	});

	test('conflict resolution modal', async ({ page }) => {
		await page.setViewportSize({ width: 860, height: 760 });
		await page.goto(harnessUrl('conflict-modal'));
		await page.waitForSelector('.modal-container');
		await page.waitForTimeout(300);
		await expect(page).toHaveScreenshot('conflict-resolution-modal.png', { fullPage: true });
	});

	test('error bridge detail', async ({ page }) => {
		await page.setViewportSize({ width: 860, height: 620 });
		await page.goto(harnessUrl('bridges'));
		await page.waitForSelector('.setting-item');
		await page.waitForTimeout(200);

		// Hover the pull button for the error bridge (Team Wiki) to show the tooltip
		const pullButtons = page.locator('button[title="Pull: repo → vault"]');
		await pullButtons.nth(1).hover(); // Team Wiki (error state)
		await page.waitForTimeout(150);
		await expect(page).toHaveScreenshot('error-state.png', { fullPage: true });
	});

	test('command bar — pill button (popdown closed)', async ({ page }) => {
		await page.setViewportSize({ width: 920, height: 560 });
		await page.goto(harnessUrl('command-bar-pill'));
		// Wait for the bar and pill to render
		await page.waitForSelector('.vault-bridges-command-bar');
		await page.waitForSelector('.vault-bridges-changes-pill');
		await page.waitForTimeout(200);
		await expect(page).toHaveScreenshot('command-bar-pill.png', { fullPage: true });
	});

	test('command bar — popdown open', async ({ page }) => {
		await page.setViewportSize({ width: 920, height: 700 });
		await page.goto(harnessUrl('command-bar-popdown'));
		// The harness clicks the pill for us — wait for popdown to appear
		await page.waitForSelector('.vault-bridges-changes-popdown');
		await page.waitForTimeout(200);
		await expect(page).toHaveScreenshot('command-bar-popdown.png', { fullPage: true });
	});
});
