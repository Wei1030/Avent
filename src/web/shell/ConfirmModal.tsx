import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Modal } from "../components/ui.js";

export function ConfirmModal() {
  const { confirmState, resolveConfirm, t } = useApp();

  return (
    <Modal
      open={Boolean(confirmState)}
      onClose={() => resolveConfirm(false)}
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
          <Button onClick={() => resolveConfirm(false)}>
            {confirmState?.cancelLabel || t("取消")}
          </Button>
          <Button
            variant={confirmState?.danger ? "danger" : "primary"}
            onClick={() => resolveConfirm(true)}
          >
            {confirmState?.confirmLabel || "确认"}
          </Button>
        </>
      }
    >
      {confirmState && (
        <div className="col" style={{ gap: 8 }}>
          <div className="confirm-msg">{confirmState.message}</div>
          {confirmState.detail && <div className="confirm-detail">{confirmState.detail}</div>}
        </div>
      )}
    </Modal>
  );
}
