// Presentation-only translations of existing logs/errors; core error codes and persisted
// transaction evidence remain in their original form.
export const runtimeMessages = {
  'Confirmation timed out. The transaction may still be pending. Do not resend. Check wallet Activity and the explorer, then recheck pending operations.':
    '確認逾時。交易可能仍待確認。請勿重送。請檢查錢包 Activity 與區塊瀏覽器，再重新檢查待確認交易。',
  'Transaction submitted, but confirmation could not be completed. Do not resend. Check wallet Activity and the explorer, then recheck pending operations.':
    '交易已送出，但無法完成確認。請勿重送。請檢查錢包 Activity 與區塊瀏覽器，再重新檢查待確認交易。',
  'The RPC read was cancelled because its context changed. No transaction was submitted by this read. Start a new read with the current settings.':
    'RPC 讀取因環境變更而取消。此次讀取未送出任何交易。請使用目前設定重新讀取。',
  'RPC endpoints are rate-limited. Retry in {seconds}s. Your RPC list was preserved.':
    'RPC 節點受到限流。請於 {seconds} 秒後重試。RPC 清單已保留。',
  'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.':
    'RPC 節點受到限流。請稍候再重試。RPC 清單已保留。',
  'Some selected VMUs are already pending in another tab/window. Wait or refresh.':
    '部分選取的 VMU 已在其他分頁或視窗中處理。請等待或重新整理。',
  'Recovery stopped during a storage change. The original backup is retained. Inspect again; do not clear site data or resend.':
    '儲存資料變更期間恢復已停止。原始備份已保留。請重新檢查；請勿清除網站資料或重送交易。',
  '{detail} · Result partially verified ({matched}/{expected} VMUs). Recheck before repeating this operation.':
    '{detail} · 結果僅部分驗證（{matched}/{expected} 個 VMU）。請重新檢查後，才可重複此操作。',
  '{detail} · Transaction confirmed; result verification incomplete. Recheck or inspect the explorer before repeating this operation.':
    '{detail} · 交易已確認，但結果尚未完整驗證。請重新檢查或查看區塊瀏覽器後，才可重複此操作。',
  'RPC configuration changed. Start a new read with the current settings.':
    'RPC 設定已變更。請使用目前設定重新讀取。',
  'this browser': '此瀏覽器',
  '{chain} RPC configuration is invalid: {error}': '{chain} RPC 設定無效：{error}',
  'The wallet confirms this nonce was consumed by another transaction. Check wallet Activity before preparing again.':
    '錢包確認此 nonce 已被另一筆交易使用。請先檢查錢包 Activity，再重新準備操作。',
  '{label} exceeded {milliseconds} ms.': '{label} 超過 {milliseconds} 毫秒時限。',
  '{label} exceeded its time limit.': '{label} 已超過時限。',
  'RPC read': 'RPC 讀取',
  'RPC retry deadline': 'RPC 重試總時限',
  'RPC health check': 'RPC 健康檢查',
  'Read operation': '讀取操作',
  'XENTurbo XEN Miner requires PC Google Chrome. You are currently using {browser}.':
    'XENTurbo XEN Miner 需要使用電腦版 Google Chrome。您目前使用的是 {browser}。',
  'Claim & Re-Mint ({days} days)': '領取並重新鑄造（{days} 天）',
  'Switch network to {chain}? Your wallet will ask for confirmation.':
    '要切換至 {chain} 網路嗎？錢包將要求您確認。',
  'No usable {chain} RPC endpoints ({available}/{total}). Your RPC list was not changed. Check internet access, DNS, firewall, and proxy/VPN settings, then recheck; or use the RPC button to change endpoints. Chain reads and transactions are blocked until a recheck succeeds.':
    '沒有可用的 {chain} RPC 節點（{available}/{total}）。RPC 清單未被變更。請檢查網路連線、DNS、防火牆及代理／VPN 設定後重新檢查，或使用 RPC 按鈕更換節點。重新檢查成功前，鏈上讀取與交易將保持停用。',
  '{chain} RPC failover active: {available}/{total} endpoints available. Unhealthy endpoints are excluded.':
    '{chain} RPC 備援已啟用：{available}/{total} 個節點可用。異常節點已暫時排除。',
  'Blocked: Transaction storage recovery is open. Close it before starting another operation.':
    '操作已鎖定：交易記錄恢復面板已開啟。請先關閉，再開始其他操作。',
  'Blocked: pending transaction check failed. Recheck before submitting.':
    '操作已鎖定：待確認交易檢查失敗。請重新檢查後再送出。',
  'Blocked: verifying pending transactions for this account and network.':
    '操作已鎖定：正在驗證此帳戶與網路的待確認交易。',
  'Blocked: {count} pending tx on-chain': '操作已鎖定：鏈上有 {count} 筆待確認交易',
  'Blocked: {count} unresolved transaction awaiting reconciliation':
    '操作已鎖定：{count} 筆尚未解決的交易等待對帳',
  'Blocked: invalid {chain} RPC configuration. Open RPC settings to correct it.':
    '操作已鎖定：{chain} RPC 設定無效。請開啟 RPC 設定修正。',
  'Blocked: no healthy {chain} RPC endpoint': '操作已鎖定：沒有可用的 {chain} RPC 節點',
  'Blocked: wallet type is not verified': '操作已鎖定：尚未驗證錢包類型',
  'WARNING: This does NOT cancel a blockchain transaction.\n\nOnly continue after checking MetaMask Activity and the block explorer and confirming that this transaction was never broadcast or is no longer pending. Marking a live transaction as dropped can allow a conflicting transaction.\n\nMark this record as dropped and unlock mining actions?':
    '警告：此操作不會取消區塊鏈交易。\n\n請先檢查 MetaMask Activity 與區塊瀏覽器，確認此交易從未廣播或已不再待確認，才可繼續。將仍有效的交易標記為已丟棄，可能導致衝突交易。\n\n要將此記錄標記為已丟棄並解除挖礦操作鎖定嗎？',
  'Checking pending transactions through the wallet...': '正在透過錢包檢查待確認交易…',
  'Pending transaction check has not completed. Recheck before submitting.':
    '待確認交易檢查尚未完成。請重新檢查後再送出。',
  'Pending check failed: {error}': '待確認交易檢查失敗：{error}',
  'Blocked: {count} pending tx on-chain. Wait, Speed up, or Cancel in MetaMask first.':
    '操作已鎖定：鏈上有 {count} 筆待確認交易。請先等待，或在 MetaMask 中加速／取消交易。',
  'A previous transaction is still pending ({count}). Wait for it in MetaMask, then retry.':
    '先前的交易仍在等待確認（{count} 筆）。請先在 MetaMask 中等待完成，再重試。',
  'Preparation cancelled. No transaction was submitted.': '準備已取消。未送出任何交易。',
  'Network changed while RPC validation was running. Recheck and save again.':
    'RPC 驗證期間網路已變更。請重新檢查並儲存。',
  'RPC validation failed': 'RPC 驗證失敗',
  'Use at most {max} RPC endpoints': '最多可設定 {max} 個 RPC 節點',
  'RPC input must not exceed {max} characters': 'RPC 輸入不得超過 {max} 個字元',
  'RPC URL must not exceed {max} characters': 'RPC 網址不得超過 {max} 個字元',
  'RPC endpoint must be a valid HTTPS URL': 'RPC 節點必須是有效的 HTTPS 網址',
  'RPC endpoint must use HTTPS': 'RPC 節點必須使用 HTTPS',
  'RPC endpoint must not contain credentials in the URL': 'RPC 網址不得包含登入憑證',
  'RPC expected chain {expected} but returned {actual}':
    'RPC 預期鏈 ID 為 {expected}，實際回傳 {actual}',
  'RPC returned HTTP {status}': 'RPC 回傳 HTTP {status}',
  'RPC returned an invalid chain id': 'RPC 回傳無效的鏈 ID',
  '{error}. Your RPC list was not changed. Open the RPC settings to correct the configuration or reset to defaults. Chain reads and transactions remain blocked until validation succeeds.':
    '{error}。RPC 清單未被變更。請開啟 RPC 設定修正或重設為預設值。驗證成功前，鏈上讀取與交易將保持停用。',
  'No configured RPC endpoint responded on the expected network. Your RPC list was preserved. Check internet access, DNS, firewall, and proxy/VPN settings, then retry; or change endpoints in RPC settings.':
    '設定的 RPC 節點均未在預期網路上回應。RPC 清單已保留。請檢查網路連線、DNS、防火牆及代理／VPN 設定後重試，或在 RPC 設定中更換節點。',
  'Browser storage is inaccessible. Restore storage access, then inspect again. No records were changed.':
    '無法存取瀏覽器儲存空間。請恢復存取權限後重新檢查。未變更任何記錄。',
  'Verifying damaged records through the connected wallet...': '正在透過已連接的錢包驗證損壞記錄…',
  'Recovery cancelled or timed out. Inspect again; no unverified records were removed.':
    '恢復已取消或逾時。請重新檢查；未刪除任何未經驗證的記錄。',
  'Recovery failed. Original records were retained.': '恢復失敗。原始記錄已保留。',
  '{repaired} settled record(s) archived and repaired. {blocked} record(s) remain blocked. Unidentified or unconfirmed records are never discarded.':
    '已封存並修復 {repaired} 筆已結算記錄。{blocked} 筆記錄仍保持鎖定。不會丟棄無法識別或尚未確認的記錄。',
  '{count} missing or unreadable transaction identities.': '{count} 筆交易識別資料缺失或無法讀取。',
  '{count} belong to another account or network.': '{count} 筆屬於其他帳戶或網路。',
  '{count} without a matching mined receipt.': '{count} 筆沒有相符的已上鏈收據。',
  '{count} deferred by the 20-record verification limit; inspect again to continue.':
    '{count} 筆因每次最多驗證 20 筆而延後；請重新檢查以繼續。',
  'Validating operation parameters...': '正在驗證操作參數…',
  'Operation parameters validated.': '操作參數已驗證。',
  'Checking configured RPC availability...': '正在檢查設定的 RPC 是否可用…',
  'Configured RPC is available.': '設定的 RPC 可用。',
  'Checking wallet network and pending transactions...': '正在檢查錢包網路與待確認交易…',
  'Wallet network is correct and no pending transaction was found.':
    '錢包網路正確，未發現待確認交易。',
  'Reading the current contract service fee...': '正在讀取目前的合約服務費…',
  'Current contract service fee loaded.': '已取得目前的合約服務費。',
  'Reserving the selected VMUs for this operation...': '正在為本次操作鎖定選取的 VMU…',
  'Selected VMUs reserved in this browser.': '選取的 VMU 已在此瀏覽器中鎖定。',
  'Rechecking selected VMU state on-chain...': '正在重新檢查選取 VMU 的鏈上狀態…',
  'Selected VMUs are still eligible.': '選取的 VMU 仍符合操作條件。',
  'Estimating gas and checking the latest block limit...': '正在估算 Gas 並檢查最新區塊上限…',
  'Gas estimate is ready. Open MetaMask to review and sign.':
    'Gas 估算已完成。請開啟 MetaMask 審閱並簽署。',
  'Preparation failed: {error}': '準備失敗：{error}',
  'Starting final checks before opening MetaMask...': '開啟 MetaMask 前，正在執行最後檢查…',
  'Checking unresolved local transaction records...': '正在檢查本機尚未解決的交易記錄…',
  'No unresolved local transaction record was found.': '未發現本機尚未解決的交易記錄。',
  'Rechecking RPC availability and pending nonce...': '正在重新檢查 RPC 可用性與待確認 nonce…',
  'RPC and pending nonce checks passed.': 'RPC 與待確認 nonce 檢查通過。',
  'Checking active wallet account and network...': '正在檢查目前的錢包帳戶與網路…',
  'Active wallet account and network match the prepared operation.':
    '目前錢包帳戶與網路符合已準備的操作。',
  'Reading the current wallet nonce and contract data...': '正在讀取目前錢包 nonce 與合約資料…',
  'Current nonce, fee, and contract data loaded.': '已取得目前的 nonce、費用與合約資料。',
  'Revalidating selected VMUs before sending...': '送出前，正在重新驗證選取的 VMU…',
  'Selected VMUs passed the final validation.': '選取的 VMU 已通過最後驗證。',
  'Simulating transaction with MetaMask...': '正在透過 MetaMask 模擬交易…',
  'Transaction simulation succeeded.': '交易模擬成功。',
  'MetaMask request opened. Review the details and confirm or reject it.':
    '已開啟 MetaMask 請求。請審閱詳細資料，然後確認或拒絕。',
  'Waiting for the transaction to be confirmed on-chain...': '正在等待鏈上確認交易…',
  'Cross-checking the receipt through the wallet...': '正在透過錢包交叉驗證收據…',
  'The transaction receipt reports an on-chain revert.': '交易收據顯示交易已在鏈上回退。',
  'Transaction confirmed on-chain. Verifying the resulting VMU state.':
    '交易已於鏈上確認。正在驗證 VMU 結果狀態。',
  'Transaction result verified.': '交易結果已驗證。',
  'Transaction confirmed, but result verification found partial success.':
    '交易已確認，但結果驗證顯示僅部分成功。',
  'Transaction confirmed, but the final result could not be fully verified.':
    '交易已確認，但無法完整驗證最終結果。',
  'Transaction stopped: {error}': '交易流程已停止：{error}',
  'Transaction submitted: {hash}.': '交易已送出：{hash}。',
  'Transaction submitted, but its local record could not be saved. Do not resend. Do not clear site data. Keep this page open, save the transaction hash from the explorer link, and check wallet Activity before rechecking pending operations.':
    '交易已送出，但無法儲存本機記錄。請勿重送或清除網站資料。請保持此頁面開啟，從區塊瀏覽器連結保留交易雜湊，並先檢查錢包 Activity，再重新檢查待確認交易。',
  '{count} VMU(s) failed to read. Refresh or check RPC — do not treat them as empty.':
    '{count} 個 VMU 讀取失敗。請重新整理或檢查 RPC；請勿將其視為空槽。',
  '{count} VMU(s) failed to read. Refresh or check RPC.':
    '{count} 個 VMU 讀取失敗。請重新整理或檢查 RPC。',
  'Failed to read chain': '鏈上資料讀取失敗',
  'Operation cancelled. No transaction was submitted.': '操作已取消。未送出任何交易。',
  'Transaction rejected': '交易已被拒絕',
  'Insufficient funds for gas + fee': '餘額不足以支付 Gas 與服務費',
  'This prepared operation has already started or finished. Check wallet Activity and recheck pending operations. Do not resend.':
    '此準備操作已開始或已結束。請檢查錢包 Activity，並重新檢查待確認交易。請勿重送。',
  'The prepared transaction expired after 2 minutes. Estimate it again before signing.':
    '準備的交易已超過 2 分鐘有效期。請重新估算後再簽署。',
  'Local transaction storage is unavailable or damaged. {action} Do not clear site data or resend; check wallet Activity first.':
    '本機交易儲存空間無法使用或已損壞。{action}請勿清除網站資料或重送；請先檢查錢包 Activity。',
  'Restore storage access, then inspect again.': '請恢復儲存空間存取權限後重新檢查。',
  'Open transaction storage recovery.': '請開啟交易記錄恢復。',
  'Wallet account or network changed. Reconnect the original account and network, then recheck transaction records. Do not resend.':
    '錢包帳戶或網路已變更。請重新連接原帳戶與網路後，重新檢查交易記錄。請勿重送。',
  'Wallet or network read timed out.{detail} Check your connection and wallet, then recheck transaction records. Do not resend.':
    '錢包或網路讀取逾時。{detail}請檢查連線與錢包後，重新檢查交易記錄。請勿重送。',
  'Wallet transaction evidence is unavailable. Check wallet Activity and the selected network, then recheck. Do not resend.':
    '無法取得錢包交易憑據。請檢查錢包 Activity 與所選網路後重新檢查。請勿重送。',
  'Wallet and read RPC disagree about the pending nonce. Do not retry yet. Open MetaMask Activity, verify the selected network, then recheck.':
    '錢包與唯讀 RPC 的待確認 nonce 不一致。請勿立即重試。請開啟 MetaMask Activity，核對所選網路後重新檢查。',
  'Wallet did not respond (it may have gone idle). Click the MetaMask extension icon or reload the page, then retry.':
    '錢包未回應（可能已閒置）。請點擊 MetaMask 擴充功能圖示或重新載入頁面後重試。',
  'Another tab is currently using this wallet. Wait for that transaction to finish, then retry.':
    '另一個分頁正在使用此錢包。請等待該交易完成後再重試。',
  'MetaMask did not return a result within 2 minutes. This page stopped waiting, but the wallet request may still be active. Check MetaMask Activity and recheck pending operations before retrying.':
    'MetaMask 未在 2 分鐘內回傳結果。此頁面已停止等待，但錢包請求可能仍在處理中。請檢查 MetaMask Activity，並重新檢查待確認交易後再重試。',
  'A previous local transaction record is unresolved. Recheck pending operations. If it remains unknown, verify MetaMask Activity and the block explorer before marking it dropped.':
    '先前的本機交易記錄尚未解決。請重新檢查待確認交易。若結果仍未知，請核對 MetaMask Activity 與區塊瀏覽器後，才可標記為已丟棄。',
  'A previous transaction is still pending. Open MetaMask → Activity, wait for it to confirm (or Speed up / Cancel it), then retry. EIP-7702 smart accounts usually allow only 1 in-flight tx.':
    '先前的交易仍待確認。請開啟 MetaMask → Activity，等待確認（或加速／取消）後再重試。EIP-7702 智能帳戶通常僅允許 1 筆處理中的交易。',
  'MetaMask has a pending request. Open the MetaMask extension, approve or reject it, then retry.':
    'MetaMask 有待處理請求。請開啟擴充功能，批准或拒絕後再重試。',
  'Wallet connector error. Reload the page and reconnect MetaMask, then retry.':
    '錢包連接器發生錯誤。請重新載入頁面並連接 MetaMask 後重試。',
  'No browser wallet detected. Open MetaMask and reconnect.':
    '未偵測到瀏覽器錢包。請開啟 MetaMask 並重新連接。',
  'Transaction reverted on-chain. Refresh the list and try again.':
    '交易已在鏈上回退。請重新整理清單後再試。',
  'RPC node error (-32603). Try switching RPC / clear pending txs in MetaMask.':
    'RPC 節點錯誤（-32603）。請嘗試切換 RPC，或在 MetaMask 中處理待確認交易。',
  'Wallet RPC endpoint error. Change the network RPC in your wallet, or use the in-app RPC button.':
    '錢包 RPC 節點發生錯誤。請在錢包中更換網路 RPC，或使用介面的 RPC 按鈕。',
  'Estimation reverted. Check VMU count/term limits and that you have enough balance for the service fee.':
    '估算時交易回退。請檢查 VMU 數量／期限上限，以及餘額是否足以支付服務費。',
  'Wallet account changed during the operation. Reconnect and retry.':
    '操作期間錢包帳戶已變更。請重新連接後重試。',
  'Wallet is on the wrong network. Switch networks and retry.':
    '錢包網路不正確。請切換網路後重試。',
  'No wallet account available. Reconnect your wallet.': '沒有可用的錢包帳戶。請重新連接錢包。',
  'Wallet type verification timed out. Check internet access and your RPC endpoints, then recheck.':
    '錢包類型驗證逾時。請檢查網路連線與 RPC 節點後重新檢查。',
  'Wallet type could not be verified. Check internet access and your RPC endpoints, then recheck.':
    '無法驗證錢包類型。請檢查網路連線與 RPC 節點後重新檢查。',
  'Wallet connection read timed out.{detail} Open your wallet extension, check network access, then retry Connect Wallet.':
    '錢包連接讀取逾時。{detail}請開啟錢包擴充功能並檢查網路連線，再重新連接錢包。',
  'Connection request rejected.': '連接請求已被拒絕。',
  'No injected wallet detected. Open this page in desktop Chrome with MetaMask (or another injected extension wallet) installed.':
    '未偵測到注入式錢包。請使用已安裝 MetaMask（或其他注入式錢包擴充功能）的電腦版 Chrome 開啟此頁面。',
  'Chain switch rejected in wallet.': '錢包已拒絕切換網路。',
  'Pending transaction': '待確認交易',
  'Claim & Re-Mint': '領取並重新鑄造',
  Claim: '領取',
  '{count} VMUs · {days}d term': '{count} 個 VMU · 期限 {days} 天',
  '{count} empty slots': '{count} 個空槽',
  'ids {ids} · re-mint {days}d': 'ID {ids} · 重新鑄造 {days} 天',
  'ids {ids} · {days}d': 'ID {ids} · {days} 天',
  'ids {ids}': 'ID {ids}',
  '{count} in-flight nonce(s) - open MetaMask Activity for the hash':
    '{count} 個處理中的 nonce；請開啟 MetaMask Activity 取得雜湊',
  '{days}d {hours}h': '{days} 天 {hours} 小時',
  '{hours}h {minutes}m': '{hours} 小時 {minutes} 分',
  '{minutes}m': '{minutes} 分',
  'Invalid transaction hash': '交易雜湊無效',
  'This transaction is already mined (no longer pending)': '此交易已上鏈（不再待確認）',
  'Transaction not found through the wallet. Check the hash / network.':
    '錢包中找不到此交易。請檢查雜湊與網路。',
  'Could not decode factory call (unsupported method)': '無法解碼工廠合約呼叫（不支援的方法）',
  'Connect wallet first': '請先連接錢包',
  'No empty VMUs selected': '尚未選取空槽 VMU',
  'No claimable VMUs selected': '尚未選取可領取的 VMU',
  'VMU ids must be unique positive whole numbers': 'VMU ID 必須是唯一的正整數'
} as const
