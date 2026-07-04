from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

try:
    from tkinter import filedialog, messagebox, scrolledtext
    import tkinter as tk
    from tkinter import ttk
except ModuleNotFoundError as exc:
    if exc.name != "tkinter":
        raise
    filedialog = messagebox = scrolledtext = tk = ttk = None

os.environ.setdefault("OPENCV_FFMPEG_LOGLEVEL", "16")

import cv2
import numpy as np
from PIL import Image

if tk is not None:
    from PIL import ImageTk
else:
    ImageTk = None


@dataclass
class VideoInfo:
    fps: float
    total_frames: int
    duration: float
    width: int
    height: int


@dataclass
class Sample:
    time: float
    hist: np.ndarray
    frame: np.ndarray


@dataclass
class SceneCluster:
    samples: list[Sample]
    centroid: np.ndarray

    @property
    def duration_hint(self) -> float:
        return len(self.samples)

    @property
    def start(self) -> float:
        return min(sample.time for sample in self.samples)

    @property
    def end(self) -> float:
        return max(sample.time for sample in self.samples)

    @property
    def representative(self) -> Sample:
        mid = len(self.samples) // 2
        return sorted(self.samples, key=lambda sample: sample.time)[mid]


def get_video_info(video_path: str) -> VideoInfo:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError("Cannot open video")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    duration = total_frames / fps if fps else 0.0
    return VideoInfo(fps=fps, total_frames=total_frames, duration=duration, width=width, height=height)


def crop_roi(frame: np.ndarray, roi: tuple[float, float, float, float] | None) -> np.ndarray:
    if roi is None:
        return frame
    height, width = frame.shape[:2]
    x1 = max(0, min(width - 1, int(roi[0] * width)))
    y1 = max(0, min(height - 1, int(roi[1] * height)))
    x2 = max(x1 + 1, min(width, int((roi[0] + roi[2]) * width)))
    y2 = max(y1 + 1, min(height, int((roi[1] + roi[3]) * height)))
    return frame[y1:y2, x1:x2]


def compute_histogram(frame_bgr: np.ndarray) -> np.ndarray:
    small = cv2.resize(frame_bgr, (160, 90), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [40, 48], [0, 180, 0, 256])
    cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
    return hist


def compare_hist(left: np.ndarray, right: np.ndarray) -> float:
    return float(cv2.compareHist(left, right, cv2.HISTCMP_CORREL))


def sample_video(
    video_path: str,
    step_seconds: float,
    roi: tuple[float, float, float, float] | None,
    on_progress,
) -> tuple[VideoInfo, list[Sample]]:
    info = get_video_info(video_path)
    cap = cv2.VideoCapture(video_path)
    step_frames = max(1, int(info.fps * step_seconds))
    frame_indices = list(range(0, info.total_frames, step_frames))
    samples: list[Sample] = []

    for index, frame_idx in enumerate(frame_indices):
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ok, frame = cap.read()
        if not ok:
            continue
        cropped = crop_roi(frame, roi)
        samples.append(Sample(time=frame_idx / info.fps, hist=compute_histogram(cropped), frame=frame))
        on_progress(int(100 * (index + 1) / max(1, len(frame_indices))))

    cap.release()
    return info, samples


def cluster_samples(samples: list[Sample], similarity: float) -> list[SceneCluster]:
    clusters: list[SceneCluster] = []
    for sample in samples:
        best_idx = -1
        best_score = -1.0
        for idx, cluster in enumerate(clusters):
            score = compare_hist(cluster.centroid, sample.hist)
            if score > best_score:
                best_score = score
                best_idx = idx
        if best_idx >= 0 and best_score >= similarity:
            cluster = clusters[best_idx]
            cluster.samples.append(sample)
            cluster.centroid = np.mean([item.hist for item in cluster.samples], axis=0).astype(np.float32)
        else:
            clusters.append(SceneCluster(samples=[sample], centroid=sample.hist.copy()))
    return sorted(clusters, key=lambda cluster: len(cluster.samples), reverse=True)


def merge_segments(segments: list[tuple[float, float]], merge_gap: float) -> list[tuple[float, float]]:
    merged: list[tuple[float, float]] = []
    for start, end in sorted(segments):
        if merged and start - merged[-1][1] <= merge_gap:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def invert_segments(segments: list[tuple[float, float]], duration: float) -> list[tuple[float, float]]:
    keep: list[tuple[float, float]] = []
    previous_end = 0.0
    for start, end in sorted(segments):
        if start > previous_end:
            keep.append((previous_end, start))
        previous_end = max(previous_end, end)
    if previous_end < duration:
        keep.append((previous_end, duration))
    return keep


def build_scene_segments(
    cluster: SceneCluster,
    sample_step: float,
    duration: float,
    merge_gap: float,
) -> list[tuple[float, float]]:
    raw = [(sample.time, min(duration, sample.time + sample_step)) for sample in cluster.samples]
    return merge_segments(raw, merge_gap)


def pad_segments(
    segments: list[tuple[float, float]],
    padding: float,
    duration: float,
    merge_gap: float,
) -> list[tuple[float, float]]:
    if padding <= 0:
        return segments
    padded = [(max(0.0, start - padding), min(duration, end + padding)) for start, end in segments]
    return merge_segments(padded, merge_gap)


def filter_short_segments(
    segments: list[tuple[float, float]],
    min_segment: float,
) -> list[tuple[float, float]]:
    return [(start, end) for start, end in segments if end - start >= min_segment]


def find_ffmpeg() -> str:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        return ffmpeg_path

    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        winget_packages = Path(local_app_data) / "Microsoft" / "WinGet" / "Packages"
        for candidate in winget_packages.glob("Gyan.FFmpeg_*/*/bin/ffmpeg.exe"):
            if candidate.is_file():
                return str(candidate)

    raise RuntimeError("ffmpeg not found in PATH or WinGet packages")


def export_segments(video_path: str, output_path: str, segments: list[tuple[float, float]], log, on_progress) -> None:
    ffmpeg = find_ffmpeg()
    if not segments:
        raise RuntimeError("No segments to export")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="scene_cutter_") as temp_dir:
        concat_path = Path(temp_dir) / "concat.txt"
        segment_paths: list[Path] = []
        with concat_path.open("w", encoding="utf-8") as concat_file:
            for idx, (start, end) in enumerate(segments):
                segment_path = Path(temp_dir) / f"segment_{idx:04d}.mp4"
                segment_paths.append(segment_path)
                log(f"Segment {idx + 1}/{len(segments)}: {start:.1f}-{end:.1f}s")
                subprocess.run(
                    [
                        ffmpeg,
                        "-y",
                        "-i",
                        video_path,
                        "-ss",
                        f"{start:.3f}",
                        "-to",
                        f"{end:.3f}",
                        "-map",
                        "0:v:0",
                        "-map",
                        "0:a?",
                        "-c:v",
                        "libx264",
                        "-c:a",
                        "aac",
                        "-preset",
                        "veryfast",
                        str(segment_path),
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                concat_file.write(f"file '{segment_path.as_posix()}'\n")
                on_progress(int(90 * (idx + 1) / len(segments)))

        log("Concatenating final video")
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_path),
                "-c",
                "copy",
                str(output),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        on_progress(100)


class App:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Video Scene Cutter")
        self.root.geometry("1040x720")

        self.video_var = tk.StringVar()
        self.output_var = tk.StringVar()
        self.sample_step = tk.DoubleVar(value=1.0)
        self.similarity = tk.DoubleVar(value=0.86)
        self.merge_gap = tk.DoubleVar(value=2.5)
        self.edge_padding = tk.DoubleVar(value=0.5)
        self.min_segment = tk.DoubleVar(value=1.0)
        self.mode = tk.StringVar(value="remove")
        self.roi_enabled = tk.BooleanVar(value=False)
        self.roi_x = tk.DoubleVar(value=0.0)
        self.roi_y = tk.DoubleVar(value=0.0)
        self.roi_w = tk.DoubleVar(value=1.0)
        self.roi_h = tk.DoubleVar(value=1.0)

        self.info: VideoInfo | None = None
        self.clusters: list[SceneCluster] = []
        self.checked_cluster_indexes: set[int] = set()
        self.preview_image: ImageTk.PhotoImage | None = None

        self._build_ui()

    def _build_ui(self) -> None:
        main = ttk.Frame(self.root, padding=12)
        main.pack(fill="both", expand=True)

        file_row = ttk.Frame(main)
        file_row.pack(fill="x")
        ttk.Label(file_row, text="Input").pack(side="left")
        ttk.Entry(file_row, textvariable=self.video_var).pack(side="left", fill="x", expand=True, padx=8)
        ttk.Button(file_row, text="Browse", command=self.choose_video).pack(side="left")

        out_row = ttk.Frame(main)
        out_row.pack(fill="x", pady=(8, 0))
        ttk.Label(out_row, text="Output").pack(side="left")
        ttk.Entry(out_row, textvariable=self.output_var).pack(side="left", fill="x", expand=True, padx=8)
        ttk.Button(out_row, text="Save as", command=self.choose_output).pack(side="left")

        controls = ttk.Frame(main)
        controls.pack(fill="x", pady=12)
        self._number(controls, "Sample step", self.sample_step, 0, 0)
        self._number(controls, "Similarity", self.similarity, 0, 2)
        self._number(controls, "Merge gap", self.merge_gap, 0, 4)
        self._number(controls, "Edge padding", self.edge_padding, 0, 6)
        self._number(controls, "Min segment", self.min_segment, 0, 8)

        roi = ttk.LabelFrame(main, text="ROI")
        roi.pack(fill="x", pady=(0, 12))
        ttk.Checkbutton(roi, text="Use ROI", variable=self.roi_enabled).grid(row=0, column=0, padx=6, pady=6)
        self._number(roi, "x", self.roi_x, 0, 1, width=6)
        self._number(roi, "y", self.roi_y, 0, 3, width=6)
        self._number(roi, "w", self.roi_w, 0, 5, width=6)
        self._number(roi, "h", self.roi_h, 0, 7, width=6)

        action_row = ttk.Frame(main)
        action_row.pack(fill="x")
        ttk.Button(action_row, text="Analyze", command=self.analyze).pack(side="left")
        ttk.Radiobutton(action_row, text="Remove selected scene", value="remove", variable=self.mode).pack(side="left", padx=16)
        ttk.Radiobutton(action_row, text="Keep only selected scene", value="keep", variable=self.mode).pack(side="left")
        ttk.Button(action_row, text="Export", command=self.export).pack(side="right")

        self.progress = ttk.Progressbar(main, maximum=100)
        self.progress.pack(fill="x", pady=12)

        body = ttk.PanedWindow(main, orient="horizontal")
        body.pack(fill="both", expand=True)

        left = ttk.Frame(body)
        body.add(left, weight=1)
        list_header = ttk.Frame(left)
        list_header.pack(fill="x")
        ttk.Label(list_header, text="Suggested repeated scenes").pack(side="left")
        ttk.Button(list_header, text="All", command=self.check_all_clusters).pack(side="right")
        ttk.Button(list_header, text="Clear", command=self.clear_checked_clusters).pack(side="right", padx=(0, 6))
        self.cluster_list = tk.Listbox(left, height=16, selectmode="browse")
        self.cluster_list.pack(fill="both", expand=True, pady=(4, 0))
        self.cluster_list.bind("<<ListboxSelect>>", lambda _event: self.show_selected_preview())
        self.cluster_list.bind("<Button-1>", self.on_cluster_click)
        self.cluster_list.bind("<space>", self.toggle_highlighted_cluster)

        right = ttk.Frame(body)
        body.add(right, weight=2)
        self.preview = ttk.Label(right, text="Preview")
        self.preview.pack(fill="both", expand=True)
        self.log_widget = scrolledtext.ScrolledText(right, height=10)
        self.log_widget.pack(fill="x", pady=(8, 0))

    def _number(self, parent, label: str, variable: tk.DoubleVar, row: int, col: int, width: int = 8) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=col, padx=(6, 2), pady=6)
        ttk.Entry(parent, textvariable=variable, width=width).grid(row=row, column=col + 1, padx=(0, 8), pady=6)

    def choose_video(self) -> None:
        path = filedialog.askopenfilename(
            title="Choose video",
            filetypes=[("Video files", "*.mp4 *.mov *.mkv *.avi *.webm"), ("All files", "*.*")],
        )
        if path:
            self.video_var.set(path)
            base = os.path.splitext(path)[0]
            self.output_var.set(base + "_cut.mp4")

    def choose_output(self) -> None:
        path = filedialog.asksaveasfilename(
            title="Save output",
            defaultextension=".mp4",
            filetypes=[("MP4", "*.mp4")],
        )
        if path:
            self.output_var.set(path)

    def selected_roi(self) -> tuple[float, float, float, float] | None:
        if not self.roi_enabled.get():
            return None
        x = min(max(self.roi_x.get(), 0.0), 1.0)
        y = min(max(self.roi_y.get(), 0.0), 1.0)
        w = min(max(self.roi_w.get(), 0.01), 1.0 - x)
        h = min(max(self.roi_h.get(), 0.01), 1.0 - y)
        return x, y, w, h

    def log(self, message: str) -> None:
        self.log_widget.insert("end", message + "\n")
        self.log_widget.see("end")
        self.root.update_idletasks()

    def set_progress(self, value: int) -> None:
        self.progress["value"] = value
        self.root.update_idletasks()

    def analyze(self) -> None:
        video = self.video_var.get()
        if not video or not os.path.isfile(video):
            messagebox.showerror("Error", "Choose an input video")
            return
        self.checked_cluster_indexes.clear()
        self.cluster_list.delete(0, "end")
        self.log_widget.delete("1.0", "end")
        self.set_progress(0)
        threading.Thread(target=self._analyze_worker, daemon=True).start()

    def _analyze_worker(self) -> None:
        try:
            self.log("Sampling video")
            info, samples = sample_video(
                self.video_var.get(),
                self.sample_step.get(),
                self.selected_roi(),
                self.set_progress,
            )
            self.info = info
            self.log(f"Video: {info.duration:.1f}s, {info.fps:.1f} fps, samples: {len(samples)}")
            self.log("Clustering similar frames")
            self.clusters = cluster_samples(samples, self.similarity.get())
            self.root.after(0, self.fill_cluster_list)
        except Exception as exc:
            self.root.after(0, lambda: messagebox.showerror("Error", str(exc)))

    def fill_cluster_list(self) -> None:
        self.checked_cluster_indexes.clear()
        self.cluster_list.delete(0, "end")
        step = self.sample_step.get()
        for idx, cluster in enumerate(self.clusters[:20], 1):
            self.cluster_list.insert("end", self.cluster_label(idx - 1, cluster, step))
        if self.clusters:
            self.cluster_list.selection_set(0)
            self.show_selected_preview()
        self.log(f"Found {len(self.clusters)} visual scene groups")

    def cluster_label(self, idx: int, cluster: SceneCluster, step: float) -> str:
        checkbox = "[x]" if idx in self.checked_cluster_indexes else "[ ]"
        approx = len(cluster.samples) * step
        return f"{checkbox} {idx + 1:02d}. about {approx:.1f}s, samples {len(cluster.samples)}, range {cluster.start:.1f}-{cluster.end:.1f}s"

    def refresh_cluster_row(self, idx: int) -> None:
        if idx >= len(self.clusters):
            return
        self.cluster_list.delete(idx)
        self.cluster_list.insert(idx, self.cluster_label(idx, self.clusters[idx], self.sample_step.get()))

    def toggle_cluster_check(self, idx: int) -> None:
        if idx in self.checked_cluster_indexes:
            self.checked_cluster_indexes.remove(idx)
        else:
            self.checked_cluster_indexes.add(idx)
        self.refresh_cluster_row(idx)
        self.cluster_list.selection_clear(0, "end")
        self.cluster_list.selection_set(idx)
        self.cluster_list.activate(idx)
        self.show_selected_preview()

    def on_cluster_click(self, event: tk.Event) -> str | None:
        idx = self.cluster_list.nearest(event.y)
        if idx < 0 or idx >= self.cluster_list.size():
            return None
        item_bounds = self.cluster_list.bbox(idx)
        if item_bounds is None:
            return None
        _x, y, _width, height = item_bounds
        if not y <= event.y <= y + height:
            return None
        if event.x <= 36:
            self.toggle_cluster_check(idx)
            return "break"
        return None

    def toggle_highlighted_cluster(self, _event: tk.Event) -> str:
        selection = self.cluster_list.curselection()
        if selection:
            self.toggle_cluster_check(int(selection[0]))
        return "break"

    def check_all_clusters(self) -> None:
        self.checked_cluster_indexes = set(range(min(20, len(self.clusters))))
        for idx in range(self.cluster_list.size()):
            self.refresh_cluster_row(idx)

    def clear_checked_clusters(self) -> None:
        self.checked_cluster_indexes.clear()
        for idx in range(self.cluster_list.size()):
            self.refresh_cluster_row(idx)

    def selected_clusters(self) -> list[SceneCluster]:
        clusters: list[SceneCluster] = []
        for idx in sorted(self.checked_cluster_indexes):
            if idx < len(self.clusters):
                clusters.append(self.clusters[idx])
        return clusters

    def preview_cluster(self) -> SceneCluster | None:
        selection = self.cluster_list.curselection()
        if not selection:
            return None
        idx = int(selection[0])
        if idx >= len(self.clusters):
            return None
        return self.clusters[idx]

    def show_selected_preview(self) -> None:
        cluster = self.preview_cluster()
        if cluster is None:
            return
        frame = cluster.representative.frame
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = Image.fromarray(rgb)
        image.thumbnail((620, 380))
        preview_image = ImageTk.PhotoImage(image)
        self.preview_image = preview_image
        self.preview.config(image=preview_image, text="")

    def export(self) -> None:
        if self.info is None:
            messagebox.showerror("Error", "Analyze video first")
            return
        if not self.output_var.get():
            messagebox.showerror("Error", "Choose output path")
            return
        clusters = self.selected_clusters()
        if not clusters:
            messagebox.showerror("Error", "Select at least one scene")
            return
        threading.Thread(target=self._export_worker, args=(clusters,), daemon=True).start()

    def _export_worker(self, clusters: list[SceneCluster]) -> None:
        try:
            assert self.info is not None
            self.set_progress(0)
            scene_segments: list[tuple[float, float]] = []
            for cluster in clusters:
                scene_segments.extend(
                    build_scene_segments(
                        cluster,
                        self.sample_step.get(),
                        self.info.duration,
                        self.merge_gap.get(),
                    )
                )
            scene_segments = merge_segments(scene_segments, self.merge_gap.get())
            scene_segments = pad_segments(
                scene_segments,
                self.edge_padding.get(),
                self.info.duration,
                self.merge_gap.get(),
            )
            if self.mode.get() == "remove":
                final_segments = invert_segments(scene_segments, self.info.duration)
            else:
                final_segments = scene_segments
            final_segments = filter_short_segments(final_segments, self.min_segment.get())
            self.log(f"Selected scenes: {len(clusters)}")
            self.log(f"Scene intervals: {len(scene_segments)}")
            self.log(f"Export intervals: {len(final_segments)}")
            export_segments(self.video_var.get(), self.output_var.get(), final_segments, self.log, self.set_progress)
            self.root.after(0, lambda: messagebox.showinfo("Done", f"Saved:\n{self.output_var.get()}"))
        except Exception as exc:
            self.root.after(0, lambda: messagebox.showerror("Error", str(exc)))


if __name__ == "__main__":
    if tk is None:
        raise RuntimeError("tkinter is required to run the desktop interface")
    root = tk.Tk()
    App(root)
    root.mainloop()
