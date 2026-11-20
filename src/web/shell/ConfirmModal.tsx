import { useEffect, useState } from "react";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Check, Modal } from "../components/ui.js";

export function ConfirmModal() {
  const { confirmState, resolveConfirm, t } = useApp();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setChecked(Boolean(confirmState?.checkbox?.defaultChecked));
  }, [confirmState]);

  return (
    <Modal
      open={Boolean(confirmState)}
      onClose={() => resolveConfirm(false, false)}
      className="confirm-modal"
      title={
        <span className="row" style={{ gap: 8 }}>
          {confirmState?.danger && (
            <Icon name="warning" size={17} style={{ color: "var(--crit)" }} />
          )}
          <span>{confirmState?.title ?? ""}</span>
        </span>
      }
      footer={
        <>
          <Button onClick={() => resolveConfirm(false, false)}>
            {confirmState?.cancelLabel || t("取消")}
          </Button>
          <Button
            variant={confirmState?.danger ? "danger" : "primary"}
            onClick={() => resolveConfirm(true, checked)}
          >
            {confirmState?.confirmLabel || "确认"}
          </Button>
        </>
      }
    >
      {confirmState && (
        <div className="col" style={{ gap: 10 }}>
          <div className="confirm-msg">{confirmState.message}</div>
          {confirmState.detail && <div className="confirm-detail">{confirmState.detail}</div>}
          {confirmState.checkbox && (
            <div style={{ paddingTop: 2 }}>
              <Check on={checked} onChange={setChecked}>
                {confirmState.checkbox.label}
              </Check>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
