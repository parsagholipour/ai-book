import 'dart:io';

export 'package:path_provider/path_provider.dart'
    show
        getApplicationDocumentsDirectory,
        getApplicationSupportDirectory,
        getTemporaryDirectory;

File appFile(String path) => File(path);
Directory appDirectory(String path) => Directory(path);
String get appPathSeparator => Platform.pathSeparator;
