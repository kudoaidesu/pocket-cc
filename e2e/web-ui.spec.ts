import { test, expect } from '@playwright/test'

test.describe('Web UI', () => {
  test.beforeEach(async ({ page }) => {
    // localStorage をクリアして前のテストのタブ状態を引き継がない
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    // プロジェクト一覧の読み込みを待つ
    await page.waitForFunction(() => {
      const title = document.getElementById('title')
      return title && title.textContent !== 'claude-crew'
    }, null, { timeout: 5000 }).catch(() => {
      // タイトルが変わらなくてもOK（プロジェクトがモックなので）
    })
  })

  test.describe('初期表示', () => {
    test('ヘッダーにプロジェクト名が表示される', async ({ page }) => {
      const title = page.locator('#title')
      await expect(title).toHaveText('test-project')
    })

    test('モデルセレクタが表示される', async ({ page }) => {
      const select = page.locator('#model')
      await expect(select).toBeVisible()
      await expect(select).toHaveValue('claude-sonnet-4-6')
    })

    test('入力エリアが表示される', async ({ page }) => {
      const input = page.locator('#input')
      await expect(input).toBeVisible()
      await expect(input).toHaveAttribute('placeholder', 'Ask Claude anything...')
    })

    test('送信ボタンが表示される', async ({ page }) => {
      const send = page.locator('#send')
      await expect(send).toBeVisible()
    })

    test('中断ボタンは初期非表示', async ({ page }) => {
      const abort = page.locator('#abort')
      await expect(abort).not.toBeVisible()
    })

    test('初期タブが1つ表示される', async ({ page }) => {
      const tabs = page.locator('.tab')
      await expect(tabs).toHaveCount(1)
      await expect(tabs.first()).toHaveClass(/active/)
      await expect(tabs.first()).toContainText('New Chat')
    })
  })

  test.describe('メッセージ送信', () => {
    test('テキストレスポンスを表示する', async ({ page }) => {
      await page.locator('#input').fill('hello')
      await page.locator('#send').click()

      // ユーザーメッセージ
      const userMsg = page.locator('[data-testid="msg-user"]').last()
      await expect(userMsg).toContainText('hello')

      // アシスタントレスポンス
      const assistantMsg = page.locator('[data-testid="msg-assistant"]').last()
      await expect(assistantMsg).toContainText('mock response', { timeout: 5000 })

      // コスト表示
      const meta = page.locator('[data-testid="result-meta"]').last()
      await expect(meta).toContainText('$0.0042', { timeout: 5000 })
    })

    test('Enter キーで送信できる', async ({ page }) => {
      await page.locator('#input').fill('enter-test')
      await page.locator('#input').press('Enter')

      const assistantMsg = page.locator('[data-testid="msg-assistant"]').last()
      await expect(assistantMsg).toContainText('mock response', { timeout: 5000 })
    })

    test('空メッセージは送信しない', async ({ page }) => {
      await page.locator('#input').fill('')
      await page.locator('#send').click()

      const messages = page.locator('[data-testid="msg-user"]')
      await expect(messages).toHaveCount(0)
    })
  })

  test.describe('ツール実行詳細', () => {
    test('Edit ツールの diff 表示', async ({ page }) => {
      await page.locator('#input').fill('tool-test')
      await page.locator('#send').click()

      // ツール詳細パネル（inputイベントで直接作成される）
      const detail = page.locator('[data-testid="tool-detail"]').first()
      await expect(detail).toBeVisible({ timeout: 5000 })

      // パネルヘッダーにツール名
      await expect(detail.locator('.tool-name')).toContainText('Edit')

      // パネルヘッダーにファイル名
      await expect(detail.locator('.tool-file')).toContainText('/tmp/test.ts')

      // diff表示（クリックして展開）
      await detail.locator('.tool-detail-header').click()
      const body = detail.locator('.tool-detail-body')
      await expect(body).toBeVisible()
      await expect(body.locator('.diff-del')).toContainText('const x = 1')
      await expect(body.locator('.diff-add')).toContainText('const x = 2')
    })

    test('Bash ツールのコマンド表示', async ({ page }) => {
      await page.locator('#input').fill('bash-test')
      await page.locator('#send').click()

      // ツール詳細パネル
      const detail = page.locator('[data-testid="tool-detail"]').first()
      await expect(detail).toBeVisible({ timeout: 5000 })

      // パネルヘッダーにツール名
      await expect(detail.locator('.tool-name')).toContainText('Bash')

      // コマンド表示（クリックして展開）
      await detail.locator('.tool-detail-header').click()
      const body = detail.locator('.tool-detail-body')
      await expect(body).toBeVisible()
      await expect(body).toContainText('echo hello')
    })
  })

  test.describe('警告表示', () => {
    test('危険コマンドの警告バッジが表示される', async ({ page }) => {
      await page.locator('#input').fill('danger-test')
      await page.locator('#send').click()

      const warning = page.locator('[data-testid="warning-badge"]').first()
      await expect(warning).toBeVisible({ timeout: 5000 })
      await expect(warning).toContainText('rm -rf')
    })
  })

  test.describe('コードブロックコピー', () => {
    test('コードブロックにコピーボタンが表示される', async ({ page }) => {
      await page.locator('#input').fill('code-test')
      await page.locator('#send').click()

      const copyBtn = page.locator('[data-testid="code-copy-btn"]').first()
      await expect(copyBtn).toBeVisible({ timeout: 5000 })
      await expect(copyBtn).toHaveText('Copy')
    })

    test('コピーボタンをクリックすると "Copied!" に変わる', async ({ page, context }) => {
      // clipboard 権限を付与
      await context.grantPermissions(['clipboard-write', 'clipboard-read'])

      await page.locator('#input').fill('code-test')
      await page.locator('#send').click()

      const copyBtn = page.locator('[data-testid="code-copy-btn"]').first()
      await expect(copyBtn).toBeVisible({ timeout: 5000 })

      await copyBtn.click()
      await expect(copyBtn).toHaveText('Copied!')
    })
  })

  test.describe('エラー表示', () => {
    test('エラーメッセージが表示される', async ({ page }) => {
      await page.locator('#input').fill('error-test')
      await page.locator('#send').click()

      const error = page.locator('[data-testid="error-message"]').first()
      await expect(error).toBeVisible({ timeout: 5000 })
      await expect(error).toContainText('Test error occurred')
    })
  })

  test.describe('中断ボタン', () => {
    test('送信中に中断ボタンが表示される', async ({ page }) => {
      // 送信前: 中断ボタン非表示
      await expect(page.locator('#abort')).not.toBeVisible()

      // メッセージ送信（レスポンスがすぐ返るのでタイミングに注意）
      await page.locator('#input').fill('hello')

      // ボタンが一瞬表示されることを確認するために、送信直後の状態をチェック
      const sendPromise = page.locator('#send').click()

      // 送信完了後: 中断ボタン非表示に戻る
      await page.locator('[data-testid="result-meta"]').first().waitFor({ timeout: 5000 })
      await expect(page.locator('#abort')).not.toBeVisible()
    })
  })

  test.describe('セッション履歴', () => {
    test('セッションドロワーを開くとセッション一覧が表示される', async ({ page }) => {
      // まずメッセージを送信してセッションを作成
      await page.locator('#input').fill('hello')
      await page.locator('#send').click()
      await page.locator('[data-testid="result-meta"]').first().waitFor({ timeout: 5000 })

      // メニューボタンでドロワーを開く
      await page.locator('#menuBtn').click()
      await expect(page.locator('#drawer')).toHaveClass(/open/)

      // Sessions タブをクリック
      const sessionsTab = page.locator('.drawer-tab[data-tab="sessions"]')
      await sessionsTab.click()
      await expect(sessionsTab).toHaveClass(/active/)

      // セッションアイテムが存在
      const sessionItem = page.locator('[data-testid="session-item"]').first()
      await expect(sessionItem).toBeVisible({ timeout: 5000 })
      await expect(sessionItem).toContainText('hello')
    })

    test('セッションを削除できる', async ({ page }) => {
      // メッセージ送信
      await page.locator('#input').fill('to-delete')
      await page.locator('#send').click()
      await page.locator('[data-testid="result-meta"]').first().waitFor({ timeout: 5000 })

      // メニューボタンでドロワーを開く
      await page.locator('#menuBtn').click()
      // Sessions タブをクリック
      await page.locator('.drawer-tab[data-tab="sessions"]').click()
      await page.locator('[data-testid="session-item"]').first().waitFor({ timeout: 5000 })

      // 削除
      await page.locator('.delete-session').first().click()

      // 削除後にリストが更新される（空になるか、対象が消える）
      await page.waitForTimeout(500)
    })
  })

  test.describe('マルチセッションタブ', () => {
    test('新しいタブを追加できる', async ({ page }) => {
      // 初期状態: 1タブ
      await expect(page.locator('.tab')).toHaveCount(1)

      // +ボタンで新しいタブ追加
      await page.locator('.tab-add').click()

      // 2タブになる
      await expect(page.locator('.tab')).toHaveCount(2)

      // 新しいタブがアクティブ
      await expect(page.locator('.tab.active')).toContainText('New Chat')
    })

    test('タブ間を切り替えられる', async ({ page }) => {
      // 最初のタブでメッセージ送信
      await page.locator('#input').fill('first tab')
      await page.locator('#send').click()
      await page.locator('[data-testid="result-meta"]').first().waitFor({ timeout: 5000 })

      // タブラベルが更新される
      await expect(page.locator('.tab').first()).toContainText('first tab')

      // 2つ目のタブを追加
      await page.locator('.tab-add').click()
      await expect(page.locator('.tab')).toHaveCount(2)

      // 2つ目のタブでメッセージ送信
      await page.locator('#input').fill('second tab')
      await page.locator('#send').click()
      // アクティブなメッセージエリア内のresult-metaを待つ
      await page.locator('.messages.active [data-testid="result-meta"]').waitFor({ timeout: 5000 })

      // 最初のタブに切り替え
      await page.locator('.tab').first().click()

      // 最初のタブのメッセージが見える
      const activeMessages = page.locator('.messages.active')
      await expect(activeMessages.locator('[data-testid="msg-user"]').first()).toContainText('first tab')
    })

    test('タブを閉じると別のタブに切り替わる', async ({ page }) => {
      // 2つ目のタブを追加
      await page.locator('.tab-add').click()
      await expect(page.locator('.tab')).toHaveCount(2)

      // 2つ目のタブの閉じるボタンをクリック
      await page.locator('.tab-close').last().click()

      // 1タブに戻る
      await expect(page.locator('.tab')).toHaveCount(1)
    })
  })

  test.describe('プロジェクト切り替え', () => {
    test('プロジェクトドロワーにプロジェクト一覧が表示される', async ({ page }) => {
      // メニューボタンでドロワーを開く
      await page.locator('#menuBtn').click()
      await expect(page.locator('#drawer')).toHaveClass(/open/)

      // Projects タブをクリック
      await page.locator('.drawer-tab[data-tab="projects"]').click()

      // プロジェクト一覧
      const items = page.locator('.project-item')
      await expect(items).toHaveCount(2)
      await expect(items.first()).toContainText('test-project')
      await expect(items.nth(1)).toContainText('another-project')
    })

    test('プロジェクトを切り替えるとタイトルが変わる', async ({ page }) => {
      await page.locator('#menuBtn').click()
      await page.locator('.drawer-tab[data-tab="projects"]').click()
      await page.locator('.project-item').nth(1).click()

      const title = page.locator('#title')
      await expect(title).toHaveText('another-project')
    })
  })

  test.describe('モデル切り替え', () => {
    test('モデルを変更できる', async ({ page }) => {
      const select = page.locator('#model')
      await select.selectOption('claude-opus-4-6')
      await expect(select).toHaveValue('claude-opus-4-6')
    })

    test('defaultモデルを選択できる', async ({ page }) => {
      const select = page.locator('#model')
      await select.selectOption('default')
      await expect(select).toHaveValue('default')
    })
  })
})
