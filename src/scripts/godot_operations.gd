#!/usr/bin/env -S godot --headless --script
extends SceneTree

## Godot MCP operations script — protocol v2
##
## Contract between this script and the TypeScript MCP server:
##   stdout   : optional human log lines, plus exactly one "[RESULT]<json>" line on success
##   stderr   : one or more "[ERROR] <message>" lines on failure
##   exit code: 0 = success, non-zero = failure
##
## Rules:
##   * Every operation returns an int exit code. Never rely on implicit success.
##   * quit() only sets a flag, so it must never be called after this dispatch
##     (it would overwrite the exit code). We call quit() exactly once.

const PROTOCOL_VERSION := 2
const RESULTS_PREFIX := "[RESULT]"

var debug_mode := false


func _init() -> void:
	var argv := OS.get_cmdline_args()
	debug_mode = "--debug-godot" in argv

	var script_index := argv.find("--script")
	if script_index == -1:
		_fatal("Could not find --script argument")
		return

	var operation_index := script_index + 2
	var params_index := script_index + 3
	if argv.size() <= params_index:
		_fatal("Usage: godot --headless --path <project> --script godot_operations.gd <operation> <json_params>")
		return

	var operation: String = argv[operation_index]
	var params_json: String = argv[params_index]

	var json := JSON.new()
	if json.parse(params_json) != OK:
		_fatal("Invalid JSON params: %s (line %d: %s)" % [
			params_json, json.get_error_line(), json.get_error_message()])
		return

	var params = json.get_data()
	if typeof(params) != TYPE_DICTIONARY:
		_fatal("params must be a JSON object")
		return

	_log("protocol=%d op=%s params=%s" % [PROTOCOL_VERSION, operation, params_json])
	quit(_dispatch(operation, params))


func _fatal(message: String) -> void:
	printerr("[ERROR] " + message)
	quit(1)


func _dispatch(operation: String, params: Dictionary) -> int:
	match operation:
		"ping":
			return _ok({"protocol": PROTOCOL_VERSION, "godot": str(Engine.get_version_info().string)})
		"read_scene":
			return read_scene(params)
		"create_scene":
			return create_scene(params)
		"add_node":
			return add_node(params)
		"modify_node":
			return modify_node(params)
		"remove_node":
			return remove_node(params)
		"attach_script":
			return attach_script(params)
		"load_sprite":
			return load_sprite(params)
		"save_scene":
			return save_scene(params)
		"export_mesh_library":
			return export_mesh_library(params)
		"get_uid":
			return get_uid(params)
		"resave_resources":
			return resave_resources(params)
		"scene_structure":
			return scene_structure(params)
		_:
			printerr("[ERROR] Unknown operation: " + operation)
			return 2


# ---------------------------------------------------------------------------
# Result / logging helpers
# ---------------------------------------------------------------------------

func _ok(data) -> int:
	print(RESULTS_PREFIX + JSON.stringify(_jsonable(data)))
	return 0


func _err(message: String, code := 1) -> int:
	printerr("[ERROR] " + message)
	return code


func _log(message: String) -> void:
	if debug_mode:
		print("[DEBUG] " + message)


func _info(message: String) -> void:
	print("[INFO] " + message)


## Convert a Godot Variant into something JSON.stringify can handle.
func _jsonable(value):
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return value
		TYPE_STRING_NAME:
			return str(value)
		TYPE_NODE_PATH:
			return str(value)
		TYPE_VECTOR2:
			return [value.x, value.y]
		TYPE_VECTOR2I:
			return [value.x, value.y]
		TYPE_VECTOR3:
			return [value.x, value.y, value.z]
		TYPE_VECTOR3I:
			return [value.x, value.y, value.z]
		TYPE_VECTOR4, TYPE_VECTOR4I:
			return [value.x, value.y, value.z, value.w]
		TYPE_COLOR:
			return [value.r, value.g, value.b, value.a]
		TYPE_QUATERNION:
			return [value.x, value.y, value.z, value.w]
		TYPE_RECT2, TYPE_RECT2I:
			return [value.position.x, value.position.y, value.size.x, value.size.y]
		TYPE_ARRAY:
			var arr := []
			for item in value:
				arr.append(_jsonable(item))
			return arr
		TYPE_DICTIONARY:
			var dict := {}
			for key in value:
				dict[str(key)] = _jsonable(value[key])
			return dict
		TYPE_PACKED_STRING_ARRAY:
			return Array(value)
		TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, \
		TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_VECTOR2_ARRAY, \
		TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY:
			return Array(value)
		TYPE_OBJECT:
			if value == null:
				return null
			var out := {"$class": value.get_class()}
			if value is Resource:
				out["$path"] = value.resource_path
			else:
				out["$string"] = str(value)
			return out
		_:
			return str(value)


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

## Accept "Scenes/a.tscn", "res://Scenes/a.tscn", "user://x.json".
## Reject absolute OS paths, drive letters and traversal.
func _res_path(raw) -> String:
	var path := str(raw).strip_edges()
	if path.is_empty():
		return ""
	if path.begins_with("res://") or path.begins_with("user://"):
		return path
	if path.begins_with("/") or path.begins_with("\\") or path.contains(":"):
		return ""
	if path.contains(".."):
		return ""
	return "res://" + path


func _abs_path(res_path: String) -> String:
	return ProjectSettings.globalize_path(res_path)


func _ensure_dir_for(res_path: String) -> int:
	var dir_res := res_path.get_base_dir()
	if dir_res.is_empty() or dir_res == "res://":
		return OK
	var abs := _abs_path(res_path)
	var dir_abs := abs.get_base_dir()
	if DirAccess.dir_exists_absolute(dir_abs):
		return OK
	_log("creating directory " + dir_abs)
	return DirAccess.make_dir_recursive_absolute(dir_abs)


# ---------------------------------------------------------------------------
# Scene helpers
# ---------------------------------------------------------------------------

## Normalize "root/A/B", "/root/A/B", "A/B", "." into a NodePath usable on root.
func _node_path(raw) -> NodePath:
	var path := str(raw).strip_edges()
	if path.is_empty() or path == "." or path == "root" or path == "/root":
		return NodePath(".")
	if path.begins_with("root/"):
		path = path.substr(5)
	elif path.begins_with("/root/"):
		path = path.substr(6)
	if path.begins_with("/"):
		path = path.substr(1)
	return NodePath(path)


func _load_scene(res_path: String):
	var packed = load(res_path)
	if packed == null or not (packed is PackedScene):
		return null
	return packed


## Structural facts read straight from the .tscn text. Used as a safety gate:
## re-packing an inherited scene or one with instanced sub-scenes silently
## flattens structure, which is worse than refusing.
func _read_scene_structure(res_path: String) -> Dictionary:
	var info := {
		"inherits": "",
		"has_inherited_base": false,
		"root_instance": false,
		"instanced_nodes": [],
		"instance_placeholder_nodes": [],
		"ext_resource_count": 0,
		"sub_resource_count": 0,
		"uid": "",
		"line_count": 0,
	}
	var abs_path := _abs_path(res_path)
	var handle := FileAccess.open(abs_path, FileAccess.READ)
	if handle == null:
		return info
	var text := handle.get_as_text()
	handle.close()
	info["line_count"] = text.count("\n") + 1

	var inherits_re := RegEx.create_from_string('inherits="([^"]+)"')
	var inherits_match := inherits_re.search(text)
	if inherits_match != null:
		info["inherits"] = inherits_match.get_string(1)
		info["has_inherited_base"] = true

	# Walk the [node ...] headers via plain line parsing (no regex escaping traps).
	# The FIRST header is the scene root: when it carries instance=ExtResource(...)
	# the file is an inherited / instanced-root scene and a re-pack really does
	# flatten it. Non-root instances survive pack() because Node.scene_file_path is
	# preserved on instantiation.
	var lines := text.split("\n")
	var node_index := 0
	for raw_line in lines:
		var line := raw_line.strip_edges()
		if not line.begins_with("[node "):
			continue
		if line.contains("instance=ExtResource"):
			if node_index == 0:
				info["root_instance"] = true
			else:
				var found_name := _extract_attr(line, "name")
				if not found_name.is_empty():
					info["instanced_nodes"].append(found_name)
		var placeholder := _extract_attr(line, "instance_placeholder")
		if not placeholder.is_empty():
			info["instance_placeholder_nodes"].append(placeholder)
		node_index += 1

	info["ext_resource_count"] = text.count("[ext_resource ")
	info["sub_resource_count"] = text.count("[sub_resource ")

	# uid lives on the [gd_scene ...] / [gd_resource ...] header line.
	for raw_line in lines:
		var header := raw_line.strip_edges()
		if header.begins_with("[gd_scene") or header.begins_with("[gd_resource"):
			var uid := _extract_attr(header, "uid")
			if not uid.is_empty():
				info["uid"] = uid
			break

	return info


## Pulls attr="value" out of a header line.
func _extract_attr(line: String, attr: String) -> String:
	var marker := attr + '="'
	var start := line.find(marker)
	if start == -1:
		return ""
	start += marker.length()
	var stop := line.find('"', start)
	if stop == -1:
		return ""
	return line.substr(start, stop - start)


## Returns "" when it is safe to re-pack, or a human readable refusal.
func _guard_scene_write(res_path: String, params: Dictionary) -> String:
	if bool(params.get("force", false)):
		return ""
	var info := _read_scene_structure(res_path)
	if info["has_inherited_base"] or info["root_instance"]:
		return ("Refusing to rewrite '%s': its root is an instance of another scene " % res_path) + \
			"(inherited scene). Re-packing copies the base scene inline and destroys the inheritance. " + \
			"Edit the base scene instead, use read_file/write_file for a surgical edit, " + \
			"or pass force=true if you accept the flattening."
	return ""


## Instantiate a scene for editing (edit-state instance keeps editor metadata).
func _instantiate_for_edit(res_path: String):
	var packed = _load_scene(res_path)
	if packed == null:
		return null
	return packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)


func _save_packed(root: Node, res_path: String) -> int:
	var dir_error := _ensure_dir_for(res_path)
	if dir_error != OK:
		return _err("Could not create directory for '%s' (error %d)" % [res_path, dir_error])

	var packed_scene := PackedScene.new()
	var pack_error := packed_scene.pack(root)
	if pack_error != OK:
		return _err("Failed to pack scene (error %d: %s)" % [pack_error, error_string(pack_error)])

	var save_error := ResourceSaver.save(packed_scene, res_path)
	if save_error != OK:
		return _err("Failed to save scene to '%s' (error %d: %s)" % [
			res_path, save_error, error_string(save_error)])

	if not FileAccess.file_exists(res_path):
		return _err("Save reported success but '%s' does not exist" % res_path)
	return OK


# ---------------------------------------------------------------------------
# Property coercion  (JSON -> Godot Variant, driven by the node's real type)
# ---------------------------------------------------------------------------

## Declared Variant type of a property, or -1 when it does not exist.
func _declared_type(node: Object, property: String) -> int:
	for entry in node.get_property_list():
		if str(entry.get("name", "")) == property:
			return int(entry.get("type", TYPE_NIL))
	return -1


func _property_exists(node: Object, property: String) -> bool:
	return _declared_type(node, property) != -1


func _coerce_value(value, target_type: int):
	match target_type:
		TYPE_VECTOR2:
			if typeof(value) == TYPE_DICTIONARY and value.has("x") and value.has("y"):
				return Vector2(float(value["x"]), float(value["y"]))
			if typeof(value) == TYPE_ARRAY and value.size() >= 2:
				return Vector2(float(value[0]), float(value[1]))
		TYPE_VECTOR2I:
			if typeof(value) == TYPE_DICTIONARY and value.has("x") and value.has("y"):
				return Vector2i(int(value["x"]), int(value["y"]))
			if typeof(value) == TYPE_ARRAY and value.size() >= 2:
				return Vector2i(int(value[0]), int(value[1]))
		TYPE_VECTOR3:
			if typeof(value) == TYPE_DICTIONARY and value.has("x") and value.has("y") and value.has("z"):
				return Vector3(float(value["x"]), float(value["y"]), float(value["z"]))
			if typeof(value) == TYPE_ARRAY and value.size() >= 3:
				return Vector3(float(value[0]), float(value[1]), float(value[2]))
		TYPE_VECTOR3I:
			if typeof(value) == TYPE_DICTIONARY and value.has("x") and value.has("y") and value.has("z"):
				return Vector3i(int(value["x"]), int(value["y"]), int(value["z"]))
			if typeof(value) == TYPE_ARRAY and value.size() >= 3:
				return Vector3i(int(value[0]), int(value[1]), int(value[2]))
		TYPE_COLOR:
			if typeof(value) == TYPE_STRING:
				return Color.from_string(str(value), Color.WHITE)
			if typeof(value) == TYPE_ARRAY and value.size() >= 3:
				var alpha := float(value[3]) if value.size() > 3 else 1.0
				return Color(float(value[0]), float(value[1]), float(value[2]), alpha)
			if typeof(value) == TYPE_DICTIONARY and value.has("r"):
				return Color(float(value["r"]), float(value["g"]), float(value["b"]), float(value.get("a", 1.0)))
		TYPE_RECT2:
			if typeof(value) == TYPE_DICTIONARY and value.has("x") and value.has("y") and value.has("w"):
				return Rect2(float(value["x"]), float(value["y"]), float(value["w"]), float(value["h"]))
			if typeof(value) == TYPE_ARRAY and value.size() >= 4:
				return Rect2(float(value[0]), float(value[1]), float(value[2]), float(value[3]))
		TYPE_NODE_PATH:
			return NodePath(str(value)) if typeof(value) == TYPE_STRING else value
		TYPE_STRING_NAME:
			return StringName(str(value)) if typeof(value) == TYPE_STRING else value
		TYPE_STRING:
			return str(value) if typeof(value) != TYPE_STRING else value
		TYPE_OBJECT:
			if value == null:
				return null
			if typeof(value) == TYPE_STRING:
				return load(_res_path(value))
			if typeof(value) == TYPE_DICTIONARY and value.has("$path") and str(value["$path"]) != "":
				return load(_res_path(value["$path"]))
			return value
		TYPE_INT:
			if typeof(value) == TYPE_BOOL:
				return 1 if value else 0
			if typeof(value) == TYPE_FLOAT:
				return int(value)
			if typeof(value) == TYPE_STRING and str(value).is_valid_int():
				return int(str(value))
		TYPE_FLOAT:
			if typeof(value) == TYPE_INT:
				return float(value)
			if typeof(value) == TYPE_STRING and str(value).is_valid_float():
				return float(str(value))
		TYPE_BOOL:
			if typeof(value) == TYPE_STRING:
				return str(value).to_lower() in ["true", "1", "yes"]
			if typeof(value) == TYPE_INT:
				return value != 0
	return value


## Applies one property and reports whether it actually took effect.
func _apply_property(node: Object, property: String, raw_value) -> Dictionary:
	var declared := _declared_type(node, property)
	if declared == -1:
		return {"property": property, "ok": false, "reason": "unknown property (not in get_property_list)"}

	# Prefer the declared type; fall back to the current value's type for untyped
	# script properties where the declaration is TYPE_NIL.
	var target_type := declared
	if target_type == TYPE_NIL:
		target_type = typeof(node.get(property))

	var expected = _coerce_value(raw_value, target_type)
	node.set(property, expected)
	var actual = node.get(property)

	var ok := true
	if expected == null:
		ok = actual == null
	elif typeof(actual) != typeof(expected):
		ok = false
	elif typeof(expected) == TYPE_OBJECT:
		ok = actual == expected
	elif var_to_str(actual) != var_to_str(expected):
		ok = false

	var entry := {"property": property, "ok": ok}
	if ok:
		entry["value"] = _jsonable(actual)
	else:
		entry["reason"] = "value not accepted by node.set(); expected %s got %s" % [
			str(expected), str(actual)]
		entry["requested"] = _jsonable(raw_value)
	return entry


# ---------------------------------------------------------------------------
# read_scene
# ---------------------------------------------------------------------------

func read_scene(params: Dictionary) -> int:
	var scene_path := _res_path(params.get("scene_path", ""))
	if scene_path.is_empty():
		return _err("scene_path is required (project-relative, e.g. 'Scenes/Main.tscn')")
	if not FileAccess.file_exists(scene_path):
		return _err("Scene file does not exist: " + scene_path)

	var packed = _load_scene(scene_path)
	if packed == null:
		return _err("Failed to load '%s' as a PackedScene. It may have missing dependencies; use read_file to inspect the raw text." % scene_path)

	var state: SceneState = packed.get_state()
	var total: int = state.get_node_count()
	var limit := int(params.get("max_nodes", 800))
	var include_properties := bool(params.get("include_properties", true))
	var only_path := str(params.get("node_path", "")).strip_edges()
	var only_prefix := ""
	if not only_path.is_empty():
		only_prefix = "." if only_path in ["root", ".", "/root"] else "./" + only_path.trim_prefix("/").trim_prefix("root/")

	var nodes := []
	var truncated := false
	for index in total:
		var raw_path := str(state.get_node_path(index))
		if not only_prefix.is_empty() and raw_path != only_prefix and not raw_path.begins_with(only_prefix + "/"):
			continue
		if nodes.size() >= limit:
			truncated = true
			break
		var node_path := "." if raw_path == "." else raw_path.trim_prefix("./")
		var instance_ref = state.get_node_instance(index)
		var entry := {
			"path": node_path,
			"name": str(state.get_node_name(index)),
			"type": str(state.get_node_type(index)),
			"owner": String(str(state.get_node_owner_path(index))).trim_prefix("./"),
			"is_root": raw_path == ".",
			"is_instance": instance_ref != null,
		}
		if instance_ref != null and instance_ref is Resource:
			entry["instance_of"] = instance_ref.resource_path
		if include_properties:
			var properties := {}
			for prop_index in state.get_node_property_count(index):
				var prop_name := str(state.get_node_property_name(index, prop_index))
				properties[prop_name] = _jsonable(state.get_node_property_value(index, prop_index))
			entry["properties"] = properties
		nodes.append(entry)

	var structure := _read_scene_structure(scene_path)
	return _ok({
		"scene_path": scene_path,
		"absolute_path": _abs_path(scene_path),
		"node_count": total,
		"returned": nodes.size(),
		"truncated": truncated,
		"uid": structure["uid"],
		"inherits": structure["inherits"],
		"instanced_nodes": structure["instanced_nodes"],
		"ext_resource_count": structure["ext_resource_count"],
		"sub_resource_count": structure["sub_resource_count"],
		"nodes": nodes,
		"warnings": _structure_warnings(structure),
	})


func _structure_warnings(structure: Dictionary) -> Array:
	var warnings := []
	if structure["has_inherited_base"] or structure["root_instance"]:
		warnings.append("Root is an instance of another scene (inherited scene): writes are blocked unless force=true.")
	if structure["instanced_nodes"].size() > 0:
		warnings.append(
			"Contains %d instanced sub-scenes %s — pack() keeps the instance references, " % [
				structure["instanced_nodes"].size(), str(structure["instanced_nodes"])] + \
			"but the whole file is rewritten and editor-only overrides may be dropped."
		)
	if structure["instance_placeholder_nodes"].size() > 0:
		warnings.append("Contains instance placeholders %s." % str(structure["instance_placeholder_nodes"]))
	return warnings


# ---------------------------------------------------------------------------
# scene_structure (cheap structural report, no property dump)
# ---------------------------------------------------------------------------

func scene_structure(params: Dictionary) -> int:
	var scene_path := _res_path(params.get("scene_path", ""))
	if scene_path.is_empty():
		return _err("scene_path is required")
	if not FileAccess.file_exists(scene_path):
		return _err("Scene file does not exist: " + scene_path)
	var structure := _read_scene_structure(scene_path)
	structure["scene_path"] = scene_path
	structure["absolute_path"] = _abs_path(scene_path)
	structure["safe_to_repack"] = _guard_scene_write(scene_path, {}) == ""
	structure["warnings"] = _structure_warnings(structure)
	return _ok(structure)


# ---------------------------------------------------------------------------
# create_scene
# ---------------------------------------------------------------------------

func create_scene(params: Dictionary) -> int:
	var scene_path := _res_path(params.get("scene_path", ""))
	if scene_path.is_empty():
		return _err("scene_path is required")
	if not scene_path.ends_with(".tscn"):
		return _err("scene_path must end with .tscn: " + scene_path)
	if FileAccess.file_exists(scene_path) and not bool(params.get("overwrite", false)):
		return _err("Scene already exists: %s (pass overwrite=true to replace it)" % scene_path)

	var root_type := str(params.get("root_node_type", "Node2D")).strip_edges()
	var root_node = _instantiate_class(root_type)
	if root_node == null:
		return _err("Could not instantiate root node type '%s'. Use a built-in class name like Node2D, Node3D, Control, Sprite2D." % root_type)
	if not (root_node is Node):
		return _err("Class '%s' is not a Node, cannot be a scene root" % root_type)

	root_node.name = str(params.get("root_node_name", "root"))
	if params.has("properties") and typeof(params["properties"]) == TYPE_DICTIONARY:
		var applied := []
		var failed := []
		for key in params["properties"]:
			var result := _apply_property(root_node, str(key), params["properties"][key])
			if result["ok"]:
				applied.append(result)
			else:
				failed.append(result)
		if failed.size() > 0:
			return _err("Scene root properties rejected: " + JSON.stringify(_jsonable(failed)))

	var root_name := str(root_node.name)
	var save_error := _save_packed(root_node, scene_path)
	root_node.free()
	if save_error != OK:
		return save_error

	return _ok({
		"scene_path": scene_path,
		"absolute_path": _abs_path(scene_path),
		"root_type": root_type,
		"root_name": root_name,
	})


# ---------------------------------------------------------------------------
# add_node
# ---------------------------------------------------------------------------

func add_node(params: Dictionary) -> int:
	var scene_path := _res_path(params.get("scene_path", ""))
	if scene_path.is_empty():
		return _err("scene_path is required")
	if not FileAccess.file_exists(scene_path):
		return _err("Scene file does not exist: " + scene_path)

	var node_type := str(params.get("node_type", "")).strip_edges()
	var node_name := str(params.get("node_name", "")).strip_edges()
	if node_type.is_empty():
		return _err("node_type is required (e.g. Sprite2D, CollisionShape2D)")
	if node_name.is_empty():
		return _err("node_name is required")

	var guard := _guard_scene_write(scene_path, params)
	if not guard.is_empty():
		return _err(guard)

	var scene_root = _instantiate_for_edit(scene_path)
	if scene_root == null:
		return _err("Failed to instantiate scene: " + scene_path)

	var parent_path := _node_path(params.get("parent_node_path", "root"))
	var parent: Node = scene_root if parent_path == NodePath(".") else scene_root.get_node_or_null(parent_path)
	if parent == null:
		scene_root.free()
		return _err("Parent node not found: %s" % str(parent_path))
	if not (parent is Node):
		scene_root.free()
		return _err("Parent path does not resolve to a node: %s" % str(parent_path))

	if parent.get_node_or_null(node_name) != null:
		scene_root.free()
		return _err("A node named '%s' already exists under '%s'. Godot would auto-rename it; pick a different name or use modify_node." % [node_name, str(parent_path)])

	var new_node = _instantiate_class(node_type)
	if new_node == null:
		scene_root.free()
		return _err("Could not instantiate node type '%s'. Use a built-in class name (Sprite2D, Marker2D, Area2D, ...)." % node_type)
	if not (new_node is Node):
		scene_root.free()
		return _err("Class '%s' is not a Node" % node_type)

	new_node.name = node_name
	parent.add_child(new_node, true)
	new_node.owner = scene_root

	var applied := []
	var failed := []
	if params.has("properties") and typeof(params["properties"]) == TYPE_DICTIONARY:
		for key in params["properties"]:
			var result := _apply_property(new_node, str(key), params["properties"][key])
			if result["ok"]:
				applied.append(result)
			else:
				failed.append(result)
		if failed.size() > 0:
			scene_root.free()
			return _err("Node properties rejected, nothing written: " + JSON.stringify(_jsonable(failed)))

	var node_path := str(scene_root.get_path_to(new_node)).trim_prefix("./")
	var save_error := _save_packed(scene_root, scene_path)
	scene_root.free()
	if save_error != OK:
		return save_error

	return _ok({
		"scene_path": scene_path,
		"node_path": node_path,
		"node_type": node_type,
		"node_name": node_name,
		"parent": str(parent_path).trim_prefix("./"),
		"properties_applied": applied,
	})


# ---------------------------------------------------------------------------
# modify_node
# ---------------------------------------------------------------------------

func modify_node(params: Dictionary) -> int:
	var scene_path := _res_path(params.get("scene_path", ""))
	if scene_path.is_empty():
		return _err("scene_path is required")
	if not FileAccess.file_exists(scene_path):
		return _err("Scene file does not exist: " + scene_path)

	var guard := _guard_scene_write(scene_path, params)
	if not guard.is_empty():
		return _err(guard)

	var scene_root = _instantiate_for_edit(scene_path)
	if scene_root == null:
		return _err("Failed to instantiate scene: " + scene_path)

	var target_path := _node_path(params.get("node_path", "root"))
	var node: Node = scene_root if target_path == NodePath(".") else scene_root.get_node_or_null(target_path)
	if node == null:
		scene_root.free()
		return _err("Node not found: %s" % str(target_path))

	var applied := []
	var failed := []
	if params.has("properties") and typeof(params["properties"]) == TYPE_DICTIONARY:
		for key in params["properties"]:
			var result := _apply_property(node, str(key), params["properties"][key])
			if result["ok"]:
				applied.append(result)
			else:
				failed.append(result)
	if failed.size() > 0:
		scene_root.free()
		return _err("Properties rejected, nothing written: " + JSON.stringify(_jsonable(failed)))

	var new_name := str(params.get("new_name", "")).strip_edges()
	if not new_name.is_empty():
		if node == scene_root:
			scene_root.free()
			return _err("Renaming the scene root is not supported through modify_node")
		node.name = new_name

	var save_error := _save_packed(scene_root, scene_path)
	var final_path := str(scene_root.get_path_to(node)).trim_prefix("./")
	scene_root.free()
	if save_error != OK:
		return save_error

	return _ok({
		"scene_path": scene_path,
		"node_path": final_path,
		"properties_applied": applied,
		"renamed_to": new_name if not new_name.is_empty() else null,
	})


# ---------------------------------------------------------------------------
# remove_node
# ---------------------------------------------------------------------------

func remove_node(params: Dictionary) -> int:
	var scene_path := _res_path(params.get("scene_path", ""))
	if scene_path.is_empty():
		return _err("scene_path is required")
	if not FileAccess.file_exists(scene_path):
		return _err("Scene file does not exist: " + scene_path)

	var guard := _guard_scene_write(scene_path, params)
	if not guard.is_empty():
		return _err(guard)

	var scene_root = _instantiate_for_edit(scene_path)
	if scene_root == null:
		return _err("Failed to instantiate scene: " + scene_path)

	var target_path := _node_path(params.get("node_path", ""))
	if target_path == NodePath("."):
		scene_root.free()
		return _err("Refusing to remove the scene root. Delete the file with delete_file instead.")

	var node: Node = scene_root.get_node_or_null(target_path)
	if node == null:
		scene_root.free()
		return _err("Node not found: %s" % str(target_path))

	var removed_path := str(scene_root.get_path_to(node)).trim_prefix("./")
	var removed_name := str(node.name)
	var child_count: int = node.get_child_count()
	if child_count > 0 and not bool(params.get("recursive", false)):
		scene_root.free()
		return _err("Node '%s' has %d children; pass recursive=true to remove the whole subtree." % [removed_path, child_count])

	node.get_parent().remove_child(node)
	node.free()

	var save_error := _save_packed(scene_root, scene_path)
	scene_root.free()
	if save_error != OK:
		return save_error

	return _ok({
		"scene_path": scene_path,
		"removed_node": removed_path,
		"removed_name": removed_name,
		"removed_children": child_count,
	})


# ---------------------------------------------------------------------------
# attach_script
# ---------------------------------------------------------------------------

func attach_script(params: Dictionary) -> int:
	var scene_path := _res_path(params.get("scene_path", ""))
	var script_path := _res_path(params.get("script_path", ""))
	var node_path_raw = params.get("node_path", "root")
	if scene_path.is_empty():
		return _err("scene_path is required")
	if script_path.is_empty():
		return _err("script_path is required (project-relative, e.g. 'Scripts/player.gd')")
	if not FileAccess.file_exists(scene_path):
		return _err("Scene file does not exist: " + scene_path)
	if not FileAccess.file_exists(script_path):
		return _err("Script file does not exist: " + script_path)
	if not (script_path.ends_with(".gd") or script_path.ends_with(".cs")):
		return _err("script_path must be a .gd or .cs file: " + script_path)

	var guard := _guard_scene_write(scene_path, params)
	if not guard.is_empty():
		return _err(guard)

	var script_resource = load(script_path)
	if script_resource == null or not (script_resource is Script):
		return _err("Failed to load '%s' as a Script. Check for parse errors with validate_script first." % script_path)

	var scene_root = _instantiate_for_edit(scene_path)
	if scene_root == null:
		return _err("Failed to instantiate scene: " + scene_path)

	var target_path := _node_path(node_path_raw)
	var node: Node = scene_root if target_path == NodePath(".") else scene_root.get_node_or_null(target_path)
	if node == null:
		scene_root.free()
		return _err("Node not found: %s" % str(target_path))

	var previous = node.get_script()
	node.set_script(script_resource)
	if node.get_script() == null:
		scene_root.free()
		return _err("Engine refused to attach script '%s' to '%s' (usually a base-class mismatch)" % [script_path, str(target_path)])

	var save_error := _save_packed(scene_root, scene_path)
	scene_root.free()
	if save_error != OK:
		return save_error

	return _ok({
		"scene_path": scene_path,
		"node_path": str(target_path).trim_prefix("./") if str(target_path) != "." else ".",
		"script_path": script_path,
		"previous_script": previous.resource_path if previous is Script else null,
	})


# ---------------------------------------------------------------------------
# load_sprite
# ---------------------------------------------------------------------------

func load_sprite(params: Dictionary) -> int:
	var scene_path := _res_path(params.get("scene_path", ""))
	var texture_path := _res_path(params.get("texture_path", ""))
	if scene_path.is_empty():
		return _err("scene_path is required")
	if texture_path.is_empty():
		return _err("texture_path is required")
	if not FileAccess.file_exists(scene_path):
		return _err("Scene file does not exist: " + scene_path)
	if not FileAccess.file_exists(texture_path):
		return _err("Texture file does not exist: " + texture_path)

	var guard := _guard_scene_write(scene_path, params)
	if not guard.is_empty():
		return _err(guard)

	var texture = load(texture_path)
	if texture == null or not (texture is Texture2D):
		return _err("Failed to load '%s' as a Texture2D" % texture_path)

	var scene_root = _instantiate_for_edit(scene_path)
	if scene_root == null:
		return _err("Failed to instantiate scene: " + scene_path)

	var target_path := _node_path(params.get("node_path", "root"))
	var node: Node = scene_root if target_path == NodePath(".") else scene_root.get_node_or_null(target_path)
	if node == null:
		scene_root.free()
		return _err("Node not found: %s" % str(target_path))

	var node_class := str(node.get_class())
	if not _property_exists(node, "texture"):
		scene_root.free()
		return _err("Node '%s' (%s) has no 'texture' property. Supported: Sprite2D, Sprite3D, TextureRect, TextureButton." % [
			str(target_path), node_class])

	node.set("texture", texture)
	if node.get("texture") != texture:
		scene_root.free()
		return _err("Node '%s' rejected the texture assignment" % str(target_path))

	var save_error := _save_packed(scene_root, scene_path)
	scene_root.free()
	if save_error != OK:
		return save_error

	return _ok({
		"scene_path": scene_path,
		"node_path": str(target_path).trim_prefix("./") if str(target_path) != "." else ".",
		"node_type": node_class,
		"texture_path": texture_path,
	})


# ---------------------------------------------------------------------------
# save_scene  (re-save, or copy to new_path)
# ---------------------------------------------------------------------------

func save_scene(params: Dictionary) -> int:
	var scene_path := _res_path(params.get("scene_path", ""))
	if scene_path.is_empty():
		return _err("scene_path is required")
	if not FileAccess.file_exists(scene_path):
		return _err("Scene file does not exist: " + scene_path)

	var target_path := scene_path
	if params.has("new_path") and not str(params["new_path"]).strip_edges().is_empty():
		target_path = _res_path(params["new_path"])
		if target_path.is_empty():
			return _err("Invalid new_path")
		if FileAccess.file_exists(target_path) and not bool(params.get("overwrite", false)):
			return _err("Target already exists: %s (pass overwrite=true)" % target_path)

	var scene_root = _instantiate_for_edit(scene_path)
	if scene_root == null:
		return _err("Failed to instantiate scene: " + scene_path)

	var save_error := _save_packed(scene_root, target_path)
	scene_root.free()
	if save_error != OK:
		return save_error

	return _ok({
		"source_scene": scene_path,
		"saved_to": target_path,
		"absolute_path": _abs_path(target_path),
	})


# ---------------------------------------------------------------------------
# export_mesh_library
# ---------------------------------------------------------------------------

func export_mesh_library(params: Dictionary) -> int:
	var scene_path := _res_path(params.get("scene_path", ""))
	var output_path := _res_path(params.get("output_path", ""))
	if scene_path.is_empty():
		return _err("scene_path is required")
	if output_path.is_empty():
		return _err("output_path is required")
	if not FileAccess.file_exists(scene_path):
		return _err("Scene file does not exist: " + scene_path)

	var scene_root = _instantiate_for_edit(scene_path)
	if scene_root == null:
		return _err("Failed to instantiate scene: " + scene_path)

	var mesh_item_names = params.get("mesh_item_names", [])
	var use_specific: bool = typeof(mesh_item_names) == TYPE_ARRAY and mesh_item_names.size() > 0

	var mesh_library := MeshLibrary.new()
	var item_id := 0
	var skipped := []

	for child in scene_root.get_children():
		if use_specific and not (str(child.name) in mesh_item_names):
			continue
		var mesh_instance: MeshInstance3D = null
		if child is MeshInstance3D:
			mesh_instance = child
		else:
			for descendant in _find_descendants(child, MeshInstance3D):
				mesh_instance = descendant
				break
		if mesh_instance == null or mesh_instance.mesh == null:
			skipped.append(str(child.name))
			continue

		mesh_library.create_item(item_id)
		mesh_library.set_item_name(item_id, str(child.name))
		mesh_library.set_item_mesh(item_id, mesh_instance.mesh)
		for descendant in _find_descendants(child, CollisionShape3D):
			if descendant.shape != null:
				mesh_library.set_item_shapes(item_id, [descendant.shape])
				break
		item_id += 1

	if item_id == 0:
		scene_root.free()
		return _err("No MeshInstance3D with a mesh found in '%s' (skipped nodes: %s). export_mesh_library only works for 3D scenes." % [
			scene_path, str(skipped)])

	var dir_error := _ensure_dir_for(output_path)
	if dir_error != OK:
		scene_root.free()
		return _err("Could not create output directory (error %d)" % dir_error)

	var save_error := ResourceSaver.save(mesh_library, output_path)
	scene_root.free()
	if save_error != OK:
		return _err("Failed to save MeshLibrary (error %d: %s)" % [save_error, error_string(save_error)])
	if not FileAccess.file_exists(output_path):
		return _err("MeshLibrary save reported success but '%s' does not exist" % output_path)

	return _ok({
		"scene_path": scene_path,
		"output_path": output_path,
		"item_count": item_id,
		"skipped_nodes": skipped,
	})


func _find_descendants(node: Node, type) -> Array:
	var found := []
	for child in node.get_children():
		if is_instance_of(child, type):
			found.append(child)
		found.append_array(_find_descendants(child, type))
	return found


# ---------------------------------------------------------------------------
# get_uid
# ---------------------------------------------------------------------------

func get_uid(params: Dictionary) -> int:
	var file_path := _res_path(params.get("file_path", ""))
	if file_path.is_empty():
		return _err("file_path is required")
	if not FileAccess.file_exists(file_path):
		return _err("File does not exist: " + file_path)

	var uid := ""
	var source := "none"

	# 1. Sidecar file (<name>.uid) — Godot 4.4 style for scripts/shaders.
	var sidecar_path := file_path + ".uid"
	if FileAccess.file_exists(sidecar_path):
		var handle := FileAccess.open(sidecar_path, FileAccess.READ)
		if handle != null:
			uid = handle.get_as_text().strip_edges()
			handle.close()
			if not uid.is_empty():
				source = "sidecar"

	# 2. Header uid="uid://..." — Godot 4.4+ scene/resource files.
	if uid.is_empty():
		var handle := FileAccess.open(file_path, FileAccess.READ)
		if handle != null:
			var header := handle.get_as_text()
			handle.close()
			var uid_re := RegEx.create_from_string('^\\[(gd_scene|gd_resource)[^\\]]*uid="(uid://[^"]+)"')
			var found := uid_re.search(header)
			if found != null:
				uid = found.get_string(2)
				source = "header"

	return _ok({
		"file": file_path,
		"absolute_path": _abs_path(file_path),
		"uid": uid if not uid.is_empty() else null,
		"source": source,
		"godot_version": str(Engine.get_version_info().string),
	})


# ---------------------------------------------------------------------------
# resave_resources
# ---------------------------------------------------------------------------

func resave_resources(params: Dictionary) -> int:
	var project_path := "res://"
	var requested := str(params.get("project_path", "")).strip_edges()
	if not requested.is_empty() and requested.begins_with("res://"):
		project_path = requested if requested.ends_with("/") else requested + "/"

	var dry_run := bool(params.get("dry_run", false))
	var files := []
	for extension in [".tscn", ".scn", ".tres", ".res", ".gd", ".gdshader"]:
		files.append_array(_find_files(project_path, extension))

	var resaved := 0
	var failed := []
	for file_path in files:
		if dry_run:
			continue
		var resource = load(file_path)
		if resource == null:
			failed.append({"file": file_path, "error": "failed to load"})
			continue
		var save_error := ResourceSaver.save(resource, file_path)
		if save_error != OK:
			failed.append({"file": file_path, "error": error_string(save_error)})
		else:
			resaved += 1

	return _ok({
		"project_path": project_path,
		"dry_run": dry_run,
		"resources_found": files.size(),
		"resources_resaved": resaved,
		"failures": failed,
	})


func _find_files(path: String, extension: String) -> Array:
	var files := []
	var dir := DirAccess.open(path)
	if dir == null:
		return files
	dir.list_dir_begin()
	var file_name := dir.get_next()
	while file_name != "":
		if dir.current_is_dir():
			if not file_name.begins_with("."):
				files.append_array(_find_files(path.path_join(file_name) + "/", extension))
		elif file_name.ends_with(extension):
			files.append(path.path_join(file_name))
		file_name = dir.get_next()
	dir.list_dir_end()
	return files


# ---------------------------------------------------------------------------
# Class instantiation (built-in classes first, then project global classes)
# ---------------------------------------------------------------------------

func _instantiate_class(class_name_string: String):
	var name_value := class_name_string.strip_edges()
	if name_value.is_empty():
		return null
	if ClassDB.class_exists(name_value):
		if ClassDB.can_instantiate(name_value):
			return ClassDB.instantiate(name_value)
		return null
	var script := _script_for_global_class(name_value)
	if script is GDScript:
		return script.new()
	return null


func _script_for_global_class(name_value: String) -> Script:
	for entry in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) == name_value:
			var script = load(str(entry.get("path", "")))
			if script is Script:
				return script
			return null
	return null
