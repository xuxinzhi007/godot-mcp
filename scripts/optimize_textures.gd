extends SceneTree

## One-off texture optimiser, run with:
##   godot --headless --path <project> --script res://tools/optimize_textures.gd
##
## 1. Coin animation frames: crop to the union of non-transparent bounds, then
##    downscale with Lanczos so the frame is ~128px wide. Prints the factor that
##    the scene's AnimatedSprite2D scale must be multiplied by.
## 2. Every other bitmap asset in Assets/: re-encode to WebP (same dimensions,
##    lossy q=0.92) so the file on disk shrinks without touching any scale.

const COIN_DIR := "res://Assets/characters/coin/"
const WEBP_DIRS := [
	"res://Assets/decorations/",
	"res://Assets/characters/",
	"res://Assets/fx/",
	"res://Assets/npc/",
	"res://Assets/ui/",
]
const TARGET_WIDTH := 128
const WEBP_QUALITY := 0.92
const SKIP_PREFIX := "_"   # already optimised / partial files


func _init() -> void:
	var summary := {"coin": {}, "webp": [], "errors": []}
	_optimise_coin(summary)
	_optimise_webp(summary)
	print("[RESULT]" + JSON.stringify(summary))
	quit(0)


func _abs(res_path: String) -> String:
	return ProjectSettings.globalize_path(res_path)


func _files_in(dir_res: String, extensions: Array) -> Array:
	var out := []
	var names := DirAccess.get_files_at(dir_res)
	if names == null:
		return out
	for name in names:
		var ext := "." + str(name).get_extension().to_lower()
		if extensions.has(ext):
			out.append(dir_res + str(name))
	out.sort()
	return out


func _optimise_coin(summary: Dictionary) -> void:
	var frames := _files_in(COIN_DIR, [".png"])
	if frames.size() == 0:
		summary["errors"].append("no coin frames found")
		return

	var images := []
	var union := Rect2i()
	var first := true
	for path in frames:
		var img := Image.load_from_file(_abs(path))
		if img == null:
			summary["errors"].append("cannot load " + path)
			return
		images.append({"path": path, "image": img})
		var used := img.get_used_rect()
		if used.size == Vector2i.ZERO:
			continue
		union = used if first else union.merge(used)
		first = false

	if union.size == Vector2i.ZERO:
		summary["errors"].append("coin frames are fully transparent")
		return

	var factor := maxi(1, int(round(maxf(float(union.size.x), float(union.size.y)) / float(TARGET_WIDTH))))
	var new_size := Vector2i(maxi(1, union.size.x / factor), maxi(1, union.size.y / factor))
	var before := 0
	var after := 0
	for entry in images:
		var img: Image = entry["image"]
		var cropped := img.get_region(union)
		cropped.resize(new_size.x, new_size.y, Image.INTERPOLATE_LANCZOS)
		var abs_path := _abs(entry["path"])
		before += FileAccess.get_file_as_bytes(abs_path).size()
		var error := cropped.save_png(abs_path)
		if error != OK:
			summary["errors"].append("save failed for " + str(entry["path"]))
			continue
		after += FileAccess.get_file_as_bytes(abs_path).size()

	summary["coin"] = {
		"frames": frames.size(),
		"original_size": [images[0]["image"].get_width(), images[0]["image"].get_height()],
		"union_rect": [union.position.x, union.position.y, union.size.x, union.size.y],
		"factor": factor,
		"new_size": [new_size.x, new_size.y],
		"bytes_before": before,
		"bytes_after": after,
	}


func _optimise_webp(summary: Dictionary) -> void:
	for dir_res in WEBP_DIRS:
		for path in _files_in(dir_res, [".png", ".jpg", ".jpeg"]):
			var name := str(path).get_file()
			if name.begins_with(SKIP_PREFIX):
				continue
			var target := str(path).get_basename() + ".webp"
			if FileAccess.file_exists(target):
				continue
			var img := Image.load_from_file(_abs(path))
			if img == null:
				summary["errors"].append("cannot load " + path)
				continue
			var before := FileAccess.get_file_as_bytes(_abs(path)).size()
			var error := img.save_webp(_abs(target), true, WEBP_QUALITY)
			if error != OK:
				summary["errors"].append("webp save failed for " + path)
				continue
			var after := FileAccess.get_file_as_bytes(_abs(target)).size()
			summary["webp"].append({
				"source": path,
				"target": target,
				"size": [img.get_width(), img.get_height()],
				"bytes_before": before,
				"bytes_after": after,
			})
