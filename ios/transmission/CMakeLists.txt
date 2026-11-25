# This iPhone's own Transmission for the Cluster app (ht_transmission.cpp): libtransmission (Transmission's own source,
# TR_SRC, built here with its own options: only the library, mbedTLS for its crypto) and curl and mbedTLS (built first,
# found through CMAKE_PREFIX_PATH), as one library the app loads, ClusterTransmission (the framework's binary), as the
# Android app's (android/app/src/cluster/cpp). scripts/build-transmission-ios.sh runs it with its iOS toolchain file.
cmake_minimum_required(VERSION 3.18)
project(cluster_transmission C CXX)

if(NOT TR_SRC)
    message(FATAL_ERROR "TR_SRC: Transmission's source folder")
endif()

add_subdirectory(${TR_SRC} transmission EXCLUDE_FROM_ALL)

add_library(ClusterTransmission SHARED ht_transmission.cpp)
target_link_libraries(ClusterTransmission PRIVATE transmission "-framework CoreFoundation" "-framework Security" "-framework SystemConfiguration")
# (only its three functions shown; named and found as a framework's binary is)
target_link_options(ClusterTransmission PRIVATE "LINKER:-exported_symbols_list,${CMAKE_CURRENT_SOURCE_DIR}/exports.txt" "LINKER:-dead_strip")
set_target_properties(ClusterTransmission PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    PREFIX ""
    SUFFIX ""
    INSTALL_NAME_DIR "@rpath/ClusterTransmission.framework"
    BUILD_WITH_INSTALL_NAME_DIR ON)
