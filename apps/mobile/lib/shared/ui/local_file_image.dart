import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

import '../storage/app_files.dart';

/// Device images retain asynchronous FileImage loading; a browser cache has
/// bytes instead of an OS file that the engine can open.
ImageProvider<Object> localFileImage(String path) => kIsWeb
    ? MemoryImage(appFile(path).readAsBytesSync())
    : FileImage(appFile(path));
