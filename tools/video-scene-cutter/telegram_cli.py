from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2

from app import (
    build_scene_segments,
    cluster_samples,
    export_segments,
    filter_short_segments,
    get_video_info,
    invert_segments,
    merge_segments,
    pad_segments,
    sample_video,
)


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def analyze(args: argparse.Namespace) -> None:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    info, samples = sample_video(args.video, args.step, None, lambda _value: None)
    clusters = cluster_samples(samples, args.similarity)[: args.limit]
    payload = {
        "video": str(Path(args.video).resolve()),
        "duration": info.duration,
        "fps": info.fps,
        "width": info.width,
        "height": info.height,
        "step": args.step,
        "merge_gap": args.merge_gap,
        "edge_padding": args.edge_padding,
        "min_segment": args.min_segment,
        "clusters": [],
    }
    for index, cluster in enumerate(clusters):
        preview_name = f"cluster_{index:02d}.jpg"
        preview_path = out_dir / preview_name
        cv2.imwrite(str(preview_path), cluster.representative.frame)
        segments = build_scene_segments(cluster, args.step, info.duration, args.merge_gap)
        payload["clusters"].append(
            {
                "index": index,
                "preview": preview_name,
                "samples": len(cluster.samples),
                "start": cluster.start,
                "end": cluster.end,
                "approx_duration": len(cluster.samples) * args.step,
                "segments": segments,
                "selected": False,
            }
        )
    write_json(out_dir / "job.json", payload)
    print(json.dumps({"job": str(out_dir / "job.json"), "clusters": len(clusters)}, ensure_ascii=False))


def export(args: argparse.Namespace) -> None:
    job_path = Path(args.job)
    payload = json.loads(job_path.read_text(encoding="utf-8"))
    selected = {int(value) for value in args.selected.split(",") if value.strip()}
    scene_segments: list[tuple[float, float]] = []
    for cluster in payload.get("clusters", []):
        if int(cluster.get("index", -1)) not in selected:
            continue
        scene_segments.extend((float(start), float(end)) for start, end in cluster.get("segments", []))
    scene_segments = merge_segments(scene_segments, float(payload.get("merge_gap", 2.5)))
    scene_segments = pad_segments(
        scene_segments,
        float(payload.get("edge_padding", 0.5)),
        float(payload.get("duration", 0.0)),
        float(payload.get("merge_gap", 2.5)),
    )
    if args.mode == "remove":
        final_segments = invert_segments(scene_segments, float(payload.get("duration", 0.0)))
    else:
        final_segments = scene_segments
    final_segments = filter_short_segments(final_segments, float(payload.get("min_segment", 1.0)))
    export_segments(payload["video"], args.output, final_segments, lambda _message: None, lambda _value: None)
    print(json.dumps({"output": str(Path(args.output).resolve()), "segments": len(final_segments)}, ensure_ascii=False))


def trim(args: argparse.Namespace) -> None:
    raw_segments = json.loads(args.segments)
    segments = [(float(start), float(end)) for start, end in raw_segments]
    segments = filter_short_segments(merge_segments(segments, 0.05), 0.05)
    export_segments(args.video, args.output, segments, lambda _message: None, lambda _value: None)
    print(json.dumps({"output": str(Path(args.output).resolve()), "segments": len(segments)}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_analyze = sub.add_parser("analyze")
    p_analyze.add_argument("--video", required=True)
    p_analyze.add_argument("--out-dir", required=True)
    p_analyze.add_argument("--step", type=float, default=1.0)
    p_analyze.add_argument("--similarity", type=float, default=0.86)
    p_analyze.add_argument("--merge-gap", type=float, default=2.5)
    p_analyze.add_argument("--edge-padding", type=float, default=0.5)
    p_analyze.add_argument("--min-segment", type=float, default=1.0)
    p_analyze.add_argument("--limit", type=int, default=8)
    p_analyze.set_defaults(func=analyze)

    p_export = sub.add_parser("export")
    p_export.add_argument("--job", required=True)
    p_export.add_argument("--selected", required=True)
    p_export.add_argument("--mode", choices=["remove", "keep"], required=True)
    p_export.add_argument("--output", required=True)
    p_export.set_defaults(func=export)

    p_trim = sub.add_parser("trim")
    p_trim.add_argument("--video", required=True)
    p_trim.add_argument("--segments", required=True)
    p_trim.add_argument("--output", required=True)
    p_trim.set_defaults(func=trim)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
