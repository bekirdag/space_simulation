export type ViewAxis = "pos-x" | "neg-x" | "pos-y" | "neg-y" | "pos-z" | "neg-z";

interface ViewControlsOptions {
  onAxis: (axis: ViewAxis) => void;
  onZoom: (factor: number) => void;
  onFrame: () => void;
  onHome: () => void;
}

interface ViewButtonSpec {
  label: string;
  title: string;
  className?: string;
  action: () => void;
}

export class ViewControls {
  private root: HTMLDivElement;

  constructor(private options: ViewControlsOptions) {
    this.root = document.createElement("div");
    this.root.id = "viewport-controls";
    this.root.className = "viewport-controls";
    this.root.setAttribute("role", "toolbar");
    this.root.setAttribute("aria-label", "Viewport controls");

    for (const eventType of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel"]) {
      this.root.addEventListener(eventType, event => event.stopPropagation());
    }

    this.root.append(this.buildAxisPad(), this.buildToolPad());
    document.body.appendChild(this.root);
  }

  private buildAxisPad(): HTMLDivElement {
    const pad = document.createElement("div");
    pad.className = "view-axis-pad";
    pad.setAttribute("aria-label", "Axis views");

    const specs: Array<ViewButtonSpec | null> = [
      null,
      { label: "+Z", title: "Top view", className: "axis-z", action: () => this.options.onAxis("pos-z") },
      null,
      { label: "-X", title: "Left view", className: "axis-x", action: () => this.options.onAxis("neg-x") },
      { label: "+Y", title: "Front view", className: "axis-y", action: () => this.options.onAxis("pos-y") },
      { label: "+X", title: "Right view", className: "axis-x", action: () => this.options.onAxis("pos-x") },
      null,
      { label: "-Y", title: "Back view", className: "axis-y", action: () => this.options.onAxis("neg-y") },
      { label: "-Z", title: "Bottom view", className: "axis-z", action: () => this.options.onAxis("neg-z") },
    ];

    for (const spec of specs) {
      if (!spec) {
        const spacer = document.createElement("span");
        spacer.className = "view-axis-spacer";
        pad.appendChild(spacer);
        continue;
      }
      pad.appendChild(this.button(spec));
    }

    return pad;
  }

  private buildToolPad(): HTMLDivElement {
    const pad = document.createElement("div");
    pad.className = "view-tool-pad";
    pad.setAttribute("aria-label", "View tools");
    pad.append(
      this.button({ label: "+", title: "Zoom in", action: () => this.options.onZoom(0.8) }),
      this.button({ label: "-", title: "Zoom out", action: () => this.options.onZoom(1.25) }),
      this.button({ label: "F", title: "Frame selected object", action: () => this.options.onFrame() }),
      this.button({ label: "H", title: "Home view", action: () => this.options.onHome() }),
    );
    return pad;
  }

  private button(spec: ViewButtonSpec): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = spec.className ? `view-control-btn ${spec.className}` : "view-control-btn";
    button.textContent = spec.label;
    button.title = spec.title;
    button.setAttribute("aria-label", spec.title);
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      spec.action();
    });
    return button;
  }
}
