# This iPhone's own libtorrent for the Cluster app: the part-runner both phone apps share
# (cluster/pieces-native/ht_pieces.cpp) with libtorrent (its own source, LT_SRC, built here as a static library with
# Boost's headers, BOOST_INCLUDE, and its own crypto: no OpenSSL), as one library the app loads, ClusterPieces (the
# framework's binary), as the Android app's (android/app/src/cluster/cpp-pieces). scripts/build-libtorrent-ios.sh runs
# it with its iOS toolchain file.
cmake_minimum_required(VERSION 3.18)
project(cluster_pieces C CXX)

if(NOT LT_SRC OR NOT BOOST_INCLUDE)
    message(FATAL_ERROR "LT_SRC: libtorrent's source folder; BOOST_INCLUDE: Boost's headers")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(Boost_INCLUDE_DIR ${BOOST_INCLUDE} CACHE PATH "" FORCE)
set(Boost_NO_BOOST_CMAKE ON CACHE BOOL "" FORCE)
set(Boost_NO_SYSTEM_PATHS ON CACHE BOOL "" FORCE)
add_subdirectory(${LT_SRC} libtorrent EXCLUDE_FROM_ALL)

set(NATIVE ${CMAKE_CURRENT_SOURCE_DIR}/../../cluster/pieces-native)
add_library(ClusterPieces SHARED ${NATIVE}/ht_pieces.cpp)
target_include_directories(ClusterPieces PRIVATE ${NATIVE})
target_link_libraries(ClusterPieces PRIVATE torrent-rasterbar "-framework CoreFoundation" "-framework SystemConfiguration")
# (only its three functions shown; named and found as a framework's binary is)
target_link_options(ClusterPieces PRIVATE "LINKER:-exported_symbols_list,${CMAKE_CURRENT_SOURCE_DIR}/exports.txt" "LINKER:-dead_strip")
set_target_properties(ClusterPieces PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    PREFIX ""
    SUFFIX ""
    INSTALL_NAME_DIR "@rpath/ClusterPieces.framework"
    BUILD_WITH_INSTALL_NAME_DIR ON)
